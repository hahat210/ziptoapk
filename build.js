#!/usr/bin/env node

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

function log(text) {
  console.log(`[BUILD] ${text}`);
}

function run(command, options = {}) {
  log(`> ${command}`);

  try {
    execSync(command, {
      stdio: 'inherit',
      ...options
    });
  } catch (error) {
    throw new Error(`Komut başarısız oldu: ${command}`);
  }
}

function safeFileName(name) {
  return String(name)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '') || 'Uygulamam';
}

function hasIndexHtml(zip) {
  return zip.getEntries().some(entry => {
    if (entry.isDirectory) {
      return false;
    }

    const name = entry.entryName
      .replace(/\\/g, '/')
      .replace(/^\/+/, '');

    return path.basename(name).toLowerCase() === 'index.html';
  });
}

function findNestedZip(zip) {
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) {
      continue;
    }

    const name = entry.entryName
      .replace(/\\/g, '/')
      .replace(/^\/+/, '');

    if (path.basename(name).toLowerCase() === 'www.zip') {
      return entry;
    }
  }

  return null;
}

function extractWebFiles() {
  const wwwDir = path.join(BUILD_DIR, 'www');

  fs.emptyDirSync(wwwDir);

  log('www.zip açılıyor...');

  let outerZip;

  try {
    outerZip = new AdmZip(ZIP_PATH);
  } catch (error) {
    throw new Error(
      `www.zip açılamadı: ${error.message}`
    );
  }

  /*
   * DURUM 1:
   *
   * www.zip
   * ├── index.html
   * ├── css/
   * └── js/
   */
  if (hasIndexHtml(outerZip)) {
    log('index.html dış ZIP içinde bulundu.');
    log('Dış ZIP doğrudan web sitesi olarak açılıyor.');

    outerZip.extractAllTo(wwwDir, true);
  } else {

    /*
     * DURUM 2:
     *
     * www.zip
     * └── www.zip
     *     ├── index.html
     *     ├── css/
     *     └── js/
     */
    const nestedEntry = findNestedZip(outerZip);

    if (!nestedEntry) {
      const files = outerZip
        .getEntries()
        .slice(0, 50)
        .map(x => x.entryName)
        .join('\n');

      throw new Error(
        'www.zip içinde index.html veya iç www.zip bulunamadı.\n\n' +
        'ZIP içeriği:\n' +
        files
      );
    }

    log(`İç www.zip bulundu: ${nestedEntry.entryName}`);

    const nestedPath =
      path.join(BUILD_DIR, '__www_inner.zip');

    fs.writeFileSync(
      nestedPath,
      nestedEntry.getData()
    );

    let innerZip;

    try {
      innerZip = new AdmZip(nestedPath);
    } catch (error) {
      fs.removeSync(nestedPath);

      throw new Error(
        `İç www.zip açılamadı: ${error.message}`
      );
    }

    if (!hasIndexHtml(innerZip)) {
      const files = innerZip
        .getEntries()
        .slice(0, 50)
        .map(x => x.entryName)
        .join('\n');

      fs.removeSync(nestedPath);

      throw new Error(
        'İç www.zip içinde index.html bulunamadı.\n\n' +
        'İç ZIP içeriği:\n' +
        files
      );
    }

    log('İç www.zip içinde index.html bulundu.');
    log('İç web sitesi çıkarılıyor...');

    innerZip.extractAllTo(wwwDir, true);

    fs.removeSync(nestedPath);
  }

  /*
   * Normal kontrol.
   */
  let indexPath = path.join(
    wwwDir,
    'index.html'
  );

  /*
   * Eğer ZIP:
   *
   * www/
   *   index.html
   *
   * şeklindeyse klasörü düzelt.
   */
  if (!fs.existsSync(indexPath)) {
    const dirs = fs.readdirSync(wwwDir);

    for (const dir of dirs) {
      const possible = path.join(
        wwwDir,
        dir,
        'index.html'
      );

      if (fs.existsSync(possible)) {
        log(`index.html alt klasörde bulundu: ${dir}`);
        log('Web klasörü düzeltiliyor...');

        const temp = path.join(
          BUILD_DIR,
          '__flatten'
        );

        fs.emptyDirSync(temp);

        fs.copySync(
          path.join(wwwDir, dir),
          temp
        );

        fs.emptyDirSync(wwwDir);

        fs.copySync(
          temp,
          wwwDir
        );

        fs.removeSync(temp);

        break;
      }
    }
  }

  indexPath = path.join(
    wwwDir,
    'index.html'
  );

  if (!fs.existsSync(indexPath)) {
    throw new Error(
      'Web dosyaları çıkarıldı fakat index.html bulunamadı.'
    );
  }

  log('Web sitesi hazır.');
  log(`index.html: ${indexPath}`);
}

function addAndroidNamespace(xml) {
  if (xml.includes('xmlns:android=')) {
    return xml;
  }

  return xml.replace(
    /<widget\s+/,
    '<widget xmlns:android="http://schemas.android.com/apk/res/android" '
  );
}

function addPermissions(xml, permissions) {
  if (!Array.isArray(permissions)) {
    return xml;
  }

  if (permissions.length === 0) {
    return xml;
  }

  log('Android izinleri ekleniyor...');

  let permissionXml = '';

  for (const permission of permissions) {
    if (!permission) {
      continue;
    }

    let p = String(permission).trim();

    if (!p) {
      continue;
    }

    if (!p.startsWith('android.permission.')) {
      p = `android.permission.${p}`;
    }

    permissionXml +=
      `        <uses-permission android:name="${p}" />\n`;
  }

  if (!permissionXml) {
    return xml;
  }

  const block =
    '\n' +
    '    <config-file parent="/manifest" target="AndroidManifest.xml">\n' +
    permissionXml +
    '    </config-file>\n';

  return xml.replace(
    '</widget>',
    `${block}</widget>`
  );
}

function addIcon(xml) {
  if (!fs.existsSync(ICON_PATH)) {
    log('icon.png yok. Varsayılan ikon kullanılacak.');
    return xml;
  }

  log('icon.png ekleniyor...');

  /*
   * Cordova'nın config.xml içindeki ikon
   * kaynağı için res klasörü.
   */
  const resDir = path.join(
    BUILD_DIR,
    'res'
  );

  fs.ensureDirSync(resDir);

  fs.copySync(
    ICON_PATH,
    path.join(resDir, 'icon.png'),
    {
      overwrite: true
    }
  );

  return xml.replace(
    '</widget>',
    '    <icon src="res/icon.png" />\n</widget>'
  );
}

function main() {
  try {
    log('========================================');
    log('ZIP TO APK');
    log('========================================');

    /*
     * Dosya kontrolleri.
     */
    if (!fs.existsSync(CONFIG_PATH)) {
      throw new Error(
        'config.json bulunamadı!'
      );
    }

    if (!fs.existsSync(ZIP_PATH)) {
      throw new Error(
        'www.zip bulunamadı!'
      );
    }

    /*
     * config.json.
     */
    let config;

    try {
      config = JSON.parse(
        fs.readFileSync(
          CONFIG_PATH,
          'utf8'
        )
      );
    } catch (error) {
      throw new Error(
        `config.json bozuk: ${error.message}`
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

    log(`App: ${appName}`);
    log(`Package: ${packageName}`);

    /*
     * Eski build temizle.
     */
    fs.removeSync(BUILD_DIR);
    fs.emptyDirSync(OUTPUT_DIR);

    /*
     * Cordova projesi.
     */
    log('Cordova projesi oluşturuluyor...');

    run(
      `cordova create "${BUILD_DIR}" "${packageName}" "${appName}"`
    );

    /*
     * ZIP içeriğini çıkar.
     */
    extractWebFiles();

    /*
     * config.xml.
     */
    const configXmlPath =
      path.join(
        BUILD_DIR,
        'config.xml'
      );

    if (!fs.existsSync(configXmlPath)) {
      throw new Error(
        'Cordova config.xml oluşturulamadı.'
      );
    }

    let configXml =
      fs.readFileSync(
        configXmlPath,
        'utf8'
      );

    configXml =
      addAndroidNamespace(configXml);

    configXml =
      addPermissions(
        configXml,
        permissions
      );

    configXml =
      addIcon(configXml);

    fs.writeFileSync(
      configXmlPath,
      configXml,
      'utf8'
    );

    /*
     * Android.
     */
    log('Android platformu ekleniyor...');

    run(
      'cordova platform add android@14.0.1',
      {
        cwd: BUILD_DIR
      }
    );

    /*
     * Android klasörü.
     */
    const androidDir =
      path.join(
        BUILD_DIR,
        'platforms',
        'android'
      );

    if (!fs.existsSync(androidDir)) {
      throw new Error(
        'Android platformu oluşturulamadı.'
      );
    }

    /*
     * APK.
     */
    log('Gradle ile APK derleniyor...');

    run(
      'gradle assembleDebug',
      {
        cwd: androidDir
      }
    );

    /*
     * APK ara.
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
      throw new Error(
        'APK oluşturulamadı. ' +
        'Gradle çıktısını kontrol et.'
      );
    }

    /*
     * Output.
     */
    const fileName =
      `${safeFileName(appName)}.apk`;

    const finalPath =
      path.join(
        OUTPUT_DIR,
        fileName
      );

    fs.copyFileSync(
      apkPath,
      finalPath
    );

    const size =
      (
        fs.statSync(finalPath).size /
        1024 /
        1024
      ).toFixed(2);

    log('========================================');
    log('APK BAŞARIYLA OLUŞTURULDU');
    log('========================================');
    log(`Dosya: ${finalPath}`);
    log(`Boyut: ${size} MB`);
    log('========================================');

  } catch (error) {
    console.error('');
    console.error('========================================');
    console.error('BUILD ERROR');
    console.error('========================================');
    console.error(
      error && error.stack
        ? error.stack
        : error
    );
    console.error('========================================');

    process.exit(1);
  }
}

main();
