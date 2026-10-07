'use strict'

// Why lazy: non-Windows installs never build the addon, so requiring it at module load would
// break any import of this package on macOS/Linux — including test collection.
let addon = null
function getAddon() {
  if (!addon) {
    addon = require('./build/Release/orca_windows_credentials.node')
  }
  return addon
}

/** Raw credential bytes, or null when the item is absent or unreadable. */
function readCredential(target) {
  return getAddon().readCredential(target) ?? null
}

/** Writes the blob, preserving the item's metadata. True only if verified by re-read. */
function writeCredential(target, blob) {
  return getAddon().writeCredential(target, Buffer.from(blob)) === true
}

/** Deletes the item. True when an item was deleted. */
function deleteCredential(target) {
  return getAddon().deleteCredential(target) === true
}

module.exports = { readCredential, writeCredential, deleteCredential }
