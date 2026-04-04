const fs = require('fs');
const path = require('path');

const LINUX_STORAGE_ROOT = '/srv/media-drop';
const LOCAL_STORAGE_ROOT = path.resolve(__dirname, '..', '.media-drop');

function canWriteToDirectory(targetPath) {
  try {
    fs.mkdirSync(targetPath, { recursive: true });
    fs.accessSync(targetPath, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function getStorageRoot() {
  if (process.env.MEDIA_DROP_STORAGE_ROOT) {
    return process.env.MEDIA_DROP_STORAGE_ROOT;
  }

  if (process.platform === 'linux') {
    return LINUX_STORAGE_ROOT;
  }

  return canWriteToDirectory(LINUX_STORAGE_ROOT) ? LINUX_STORAGE_ROOT : LOCAL_STORAGE_ROOT;
}

function getDbPath() {
  return process.env.MEDIA_DROP_DB_PATH || path.join(getStorageRoot(), 'db', 'media-drop.sqlite');
}

module.exports = {
  getDbPath,
  getStorageRoot,
};
