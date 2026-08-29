#!/usr/bin/env node

/*
 * GitHub Actions ZIP -> APK dönüştürücü
 *
 * Beklenen dosyalar:
 *   - www.zip      zorunlu
 *   - config.json  zorunlu
 *   - icon.png     isteğe bağlı
 *
 * www.zip şu iki yapıyı da destekler:
 *
 * 1) www.zip
 *    ├── index.html
 *    ├── css/
 *    └── js/
 *
 * 2) www.zip
 *    └── www.zip
 *        ├── index.html
 *        ├── css/
 *        └── js/
 *
 * Çıktı:
 *   output/<appName>.apk
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

function log(message) {
  console.log(`[BUILD] ${message}`);
}

function fail(message) {
  console.error('');
  console.error('========================================');
  console.error('BUILD HATASI');
  console.error('========================================');
  console.error(message);
  console.error('========================================');
  console.error('');
  process.exit(1);
}

function run(command, options = {}) {
  log(`> ${command}`);

  try {
    execSync(command, {
      stdio: 'inherit',
      ...options
    });
  } catch (error) {
    fail(`Komut başarısız oldu:\n${command}`);
  }
}

/*
 * ZIP'in içinde index.html var mı?
 */
function zipContainsIndex(zip) {
  return zip.getEntries().some(entry => {
    if (entry.isDirectory) return false;

    const name = entry.entryName
      .replace(/\\/g, '/')
      .replace(/^\/+/, '');

    return path.basename(name).toLowerCase() === 'index.html';
  });
}

/*
 * ZIP'in içinde başka bir www.zip bul.
 */
function findNestedWwwZip(zip) {
  const entries = zip.getEntries();

  for (const entry of entries) {
    if (entry.isDirectory) continue;

    const name = entry.entryName
      .replace(/\\/g, '/')
      .replace(/^\/+/, '');

    if (path.basename(name).toLowerCase() === 'www.zip') {
      return entry;
    }
  }

  return null;
}

/*
 * Web ZIP'ini doğru şekilde www klasörüne çıkarır.
 *
 * Öncelik:
 *   1. Dış ZIP'in içinde index.html varsa direkt aç
 *   2. Yoksa içindeki www.zip'i aç
 *   3. İç ZIP'in içinde index.html kontrol et
 */
function extractWebFiles() {
  const wwwDir = path.join(BUILD_DIR, 'www');

  fs.emptyDirSync(wwwDir);

  log('www.zip okunuyor...');

  let outerZip;

  try {
    outerZip = new AdmZip(ZIP_PATH);
    outerZip.getEntries();
  } catch (error) {
    fail(`www.zip açılamadı: ${error.message}`);
  }

  const outerEntries = outerZip.getEntries();

  log(`Dış ZIP içerisinde ${outerEntries.length} kayıt bulundu.`);

  /*
   * Önce dış ZIP'in doğrudan web sitesi olup olmadığını kontrol et.
   */
  if (zipContainsIndex(outerZip)) {
    log('Dış ZIP içerisinde index.html bulundu.');
    log('Web dosyaları doğrudan çıkarılıyor...');

    outerZip.extractAllTo(wwwDir, true);
  } else {
    /*
     * Dış ZIP'in içinde www.zip ara.
     */
    const nestedEntry = findNestedWwwZip(outerZip);

    if (!nestedEntry) {
      log('Dış ZIP içerisinde index.html bulunamadı.');
      log('İç www.zip de bulunamadı.');

      const names = outerEntries
        .slice(0, 30)
        .map(e => e.entryName)
        .join('\n');

      fail(
        'Geçerli web içeriği bulunamadı.\n\n' +
        'ZIP içeriğinin ilk kayıtları:\n' +
        names
      );
    }

    log(`İç ZIP bulundu: ${nestedEntry.entryName}`);
    log('İç www.zip çıkarılıyor...');

    const nestedZipPath = path.join(BUILD_DIR, '__nested_www.zip');

    fs.writeFileSync(
      nestedZipPath,
      nestedEntry.getData()
    );

    let nestedZip;

    try {
      nestedZip = new AdmZip(nestedZipPath);
    } catch (error) {
      fs.removeSync(nestedZipPath);
      fail(`İç www.zip açılamadı: ${error.message}`);
    }

    if (!zipContainsIndex(nestedZip)) {
      fs.removeSync(nestedZipPath);

      const names = nestedZip
        .getEntries()
        .slice(0, 30)
        .map(e => e.entryName)
        .join('\n');

      fail(
        'İç www.zip içerisinde index.html bulunamadı.\n\n' +
        'İç ZIP kayıtları:\n' +
        names
      );
    }

    log('İç www.zip içerisinde index.html bulundu.');
    log('Web dosyaları çıkarılıyor...');

    nestedZip.extractAllTo(wwwDir, true);

    fs.removeSync(nestedZipPath);
  }

  /*
   * Çıkarma sonrası index.html gerçekten var mı?
   */
  const indexPath = path.join(wwwDir, 'index.html');

  if (!fs.existsSync(indexPath)) {
    /*
     * Bazı ZIP'lerde:
     *
     * www/
     *   index.html
     *
     * şeklinde ekstra klasör olabilir.
     *
     * Onu da otomatik düzelt.
     */
    const possibleFolders = fs
      .readdirSync(wwwDir)
      .filter(name => {
        const full = path.join(wwwDir, name);
        return fs.statSync(full).isDirectory();
      });

    let foundIndex = null;

    for (const folder of possibleFolders) {
      const candidate = path.join(
        wwwDir,
        folder,
        'index.html'
      );

      if (fs.existsSync(candidate)) {
        foundIndex = candidate;
        break;
      }
    }

    if (foundIndex) {
      log('index.html alt klasörde bulundu.');
      log('Web klasörü düzleştiriliyor...');

      const tempDir = path.join(BUILD_DIR, '__flatten');

      fs.emptyDirSync(tempDir);

      fs.copySync(
        path.dirname(foundIndex),
        tempDir
      );

      fs.emptyDirSync(wwwDir);

      fs.copySync(
        tempDir,
        wwwDir
      );

      fs.removeSync(tempDir);
    }
  }

  if (!fs.existsSync(indexPath)) {
    fail(
      'Web dosyaları çıkarıldı fakat www/index.html bulunamadı.'
    );
  }

  log('Web içeriği başarıyla hazırlandı.');
  log(`index.html: ${indexPath}`);
}

/*
 * Uygulama adını güvenli APK dosya adına çevir.
 */
function safeFileName(name) {
  return String(name)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '') || 'Uygulamam';
}

/*
 * Android izinlerini config.xml'e ekle.
 */
function addPermissions(configContent, permissions) {
  if (!Array.isArray(permissions) || permissions.length === 0) {
    return configContent;
  }

  log('Android izinleri yapılandırılıyor...');

  let permissionXml = '';

  for (const permission of permissions) {
    if (!permission) continue;

    /*
     * Kullanıcı config.json'a:
     *
     * CAMERA
     *
     * yazıyorsa:
     *
     * android.permission.CAMERA
     *
     * oluştur.
     *
     * Eğer zaten android.permission. ile başlıyorsa
     * tekrar ekleme.
     */
    const cleanPermission = String(permission).trim();

    if (!cleanPermission) continue;

    const androidPermission =
      cleanPermission.startsWith('android.permission.')
        ? cleanPermission
        : `android.permission.${cleanPermission}`;

    permissionXml +=
      `        <uses-permission android:name="${androidPermission}" />\n`;
  }

  if (!permissionXml) {
    return configContent;
  }

  const configFileBlock =
    `\n    <config-file parent="/manifest" target="AndroidManifest.xml">\n` +
    permissionXml +
    `    </config-file>\n`;

  return configContent.replace(
    '</widget>',
    `${configFileBlock}</widget>`
  );
}

/*
 * İkonu config.xml'e ekle.
 */
function addIcon(configContent) {
  if (!fs.existsSync(ICON_PATH)) {
    log('icon.png bulunamadı. Varsayılan ikon kullanılacak.');
    return configContent;
  }

  log('Uygulama ikonu hazırlanıyor...');

  const iconTarget = path.join(
    BUILD_DIR,
    'res',
    'icon.png'
  );

  fs.ensureDirSync(path.dirname(iconTarget));

  fs.copySync(
    ICON_PATH,
    iconTarget,
    { overwrite: true }
  );

  return configContent.replace(
    '</widget>',
    '    <icon src="res/icon.png" />\n</widget>'
  );
}

/*
 * config.xml Android namespace kontrolü.
 */
function ensureAndroidNamespace(configContent) {
  if (configContent.includes('xmlns:android=')) {
    return configContent;
  }

  return configContent.replace(
    /<widget\s+/,
    '<widget xmlns:android="http://schemas.android.com/apk/res/android" '
  );
}

/*
 * Ana build işlemi.
 */
function main() {
  log('========================================');
  log('ZIP -> APK BUILD BAŞLIYOR');
  log('========================================');

  /*
   * Gerekli dosyalar.
   */
  if (!fs.existsSync(CONFIG_PATH)) {
    fail(
      'config.json bulunamadı! ' +
      'Repo kökünde bulunmalı.'
    );
  }

  if (!fs.existsSync(ZIP_PATH)) {
    fail(
      'www.zip bulunamadı! ' +
      'Repo kökünde bulunmalı.'
    );
  }

  /*
   * config.json oku.
   */
  let config;

  try {
    config = JSON.parse(
      fs.readFileSync(CONFIG_PATH, 'utf8')
    );
  } catch (error) {
    fail(
      `config.json okunamadı:\n${error.message}`
    );
  }

  const appName =
    config.appName || 'Uygulamam';

  const packageName =
    config.packageName || 'com.example.app';

  const permissions =
    Array.isArray(config.permissions)
      ? config.permissions
      : [];

  log(`Uygulama adı: ${appName}`);
  log(`Package adı: ${packageName}`);
  log(`İzin sayısı: ${permissions.length}`);

  /*
   * Eski build'i temizle.
   */
  log('Eski build klasörleri temizleniyor...');

  fs.removeSync(BUILD_DIR);
  fs.ensureDirSync(BUILD_DIR);

  fs.emptyDirSync(OUTPUT_DIR);

  /*
   * Cordova projesini oluştur.
   */
  log('Cordova projesi oluşturuluyor...');

  run(
    `cordova create "${BUILD_DIR}" "${packageName}" "${appName}"`
  );

  /*
   * Web dosyalarını çıkar.
   */
  extractWebFiles();

  /*
   * config.xml.
   */
  const configXmlPath =
    path.join(BUILD_DIR, 'config.xml');

  if (!fs.existsSync(configXmlPath)) {
    fail(
      'Cordova config.xml oluşturulamadı.'
    );
  }

  let configContent =
    fs.readFileSync(
      configXmlPath,
      'utf8'
    );

  /*
   * Android namespace.
   */
  configContent =
    ensureAndroidNamespace(configContent);

  /*
   * İzinler.
   */
  configContent =
    addPermissions(
      configContent,
      permissions
    );

  /*
   * İkon.
   */
  configContent =
    addIcon(configContent);

  /*
   * config.xml kaydet.
   */
  fs.writeFileSync(
    configXmlPath,
    configContent,
    'utf8'
  );

  log('config.xml hazırlandı.');

  /*
   * Android platformunu ekle.
   *
   * Workflow'da cordova-android sürümü
   * sabitlenmişse onu kullan.
   *
   * Aksi halde mevcut Cordova ayarını kullan.
   */
  log('Android platformu ekleniyor...');

  run(
    'cordova platform add android',
    {
      cwd: BUILD_DIR
    }
  );

  /*
   * Android projesi.
   */
  const androidDir =
    path.join(
      BUILD_DIR,
      'platforms',
      'android'
    );

  if (!fs.existsSync(androidDir)) {
    fail(
      'Cordova Android platformu oluşturulamadı.'
    );
  }

  /*
   * Gradle build.
   */
  log('APK derleniyor...');

  run(
    'gradle assembleDebug',
    {
      cwd: androidDir
    }
  );

  /*
   * APK'yı bul.
   */
  const apkPath =
    path.join(
      androidDir,
      'app',
      'build',
      'outputs',
      'apk',
      'debug',
      'app-debug.apk'
    );

  if (!fs.existsSync(apkPath)) {
    fail(
      'APK üretilemedi!\n' +
      `Beklenen dosya:\n${apkPath}`
    );
  }

  /*
   * Son çıktı.
   */
  const finalName =
    `${safeFileName(appName)}.apk`;

  const finalPath =
    path.join(
      OUTPUT_DIR,
      finalName
    );

  fs.copyFileSync(
    apkPath,
    finalPath
  );

  /*
   * Boyut.
   */
  const stats =
    fs.statSync(finalPath);

  const sizeMb =
    (stats.size / 1024 / 1024)
      .toFixed(2);

  log('========================================');
  log('BUILD BAŞARILI!');
  log('========================================');
  log(`APK: ${finalPath}`);
  log(`Boyut: ${sizeMb} MB`);
  log('========================================');
}

/*
 * Global hata yakalama.
 */
process.on('uncaughtException', error => {
  fail(
    error && error.stack
      ? error.stack
      : String(error)
  );
});

process.on('unhandledRejection', error => {
  fail(
    error && error.stack
      ? error.stack
      : String(error)
  );
});

main();
