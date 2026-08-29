#!/usr/bin/env node
/*
 * GitHub Actions üzerinde çalışan ZIP -> APK dönüştürücü.
 * Repo kökünde şu dosyaları bekler:
 *   - www.zip      (web kaynakların, zorunlu)
 *   - config.json  (appName, packageName, permissions - zorunlu)
 *   - icon.png     (uygulama ikonu - isteğe bağlı)
 *
 * Çıktı: output/<appName>.apk
 */
const fs = require('fs-extra');
const path = require('path');
const { execSync } = require('child_process');
const AdmZip = require('adm-zip');

const ROOT = process.cwd();
const CONFIG_PATH = path.join(ROOT, 'config.json');
const ZIP_PATH = path.join(ROOT, 'www.zip');
const ICON_PATH = path.join(ROOT, 'icon.png');
const BUILD_DIR = path.join(ROOT, 'build_temp');
const OUTPUT_DIR = path.join(ROOT, 'output');

function log(msg) {
  console.log(`[BUILD] ${msg}`);
}

function run(cmd, opts = {}) {
  log(`> ${cmd}`);
  execSync(cmd, { stdio: 'inherit', ...opts });
}

function main() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error('config.json bulunamadı! Repo kökünde olmalı.');
  }
  if (!fs.existsSync(ZIP_PATH)) {
    throw new Error('www.zip bulunamadı! Repo kökünde olmalı.');
  }

  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const appName = config.appName || 'Uygulamam';
  const packageName = config.packageName || 'com.example.app';
  const permissions = config.permissions || [];

  fs.removeSync(BUILD_DIR);
  fs.ensureDirSync(BUILD_DIR);
  fs.ensureDirSync(OUTPUT_DIR);

  log('Cordova projesi oluşturuluyor...');
  run(`cordova create "${BUILD_DIR}" "${packageName}" "${appName}"`);

  log('Web kaynakları aktarılıyor...');
  const wwwDir = path.join(BUILD_DIR, 'www');
  fs.emptyDirSync(wwwDir);
  new AdmZip(ZIP_PATH).extractAllTo(wwwDir, true);

  const configXmlPath = path.join(BUILD_DIR, 'config.xml');
  let configContent = fs.readFileSync(configXmlPath, 'utf8');

  // "android:name" özniteliğini kullanabilmek için namespace tanımı şart.
  if (!configContent.includes('xmlns:android=')) {
    configContent = configContent.replace(
      /<widget /,
      '<widget xmlns:android="http://schemas.android.com/apk/res/android" '
    );
  }

  if (permissions.length > 0) {
    log('İzinler yapılandırılıyor...');
    let permTags = '\n    <config-file parent="/manifest" target="AndroidManifest.xml">\n';
    permissions.forEach(p => {
      permTags += `        <uses-permission android:name="android.permission.${p}" />\n`;
    });
    permTags += '    </config-file>\n';
    configContent = configContent.replace('</widget>', `${permTags}</widget>`);
  }

  if (fs.existsSync(ICON_PATH)) {
    log('Uygulama simgesi ekleniyor...');
    const iconTarget = path.join(BUILD_DIR, 'res', 'icon.png');
    fs.ensureDirSync(path.dirname(iconTarget));
    fs.copySync(ICON_PATH, iconTarget);
    configContent = configContent.replace('</widget>', '    <icon src="res/icon.png" />\n</widget>');
  }

  fs.writeFileSync(configXmlPath, configContent);

  log('Android platformu ekleniyor...');
  run('cordova platform add android', { cwd: BUILD_DIR });

  log('APK derleniyor (Gradle)...');
  const androidDir = path.join(BUILD_DIR, 'platforms', 'android');
  run('gradle assembleDebug', { cwd: androidDir });

  const apkPath = path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
  if (!fs.existsSync(apkPath)) {
    throw new Error('APK üretilemedi! Derleme loglarını kontrol et.');
  }

  const finalName = `${appName.replace(/[^a-zA-Z0-9]/g, '_')}.apk`;
  const finalPath = path.join(OUTPUT_DIR, finalName);
  fs.copySync(apkPath, finalPath);
  log(`BAŞARILI! Çıktı: ${finalPath}`);
}

main();
