const path = require('path');

const ORIGINAL_RE = /^photo_(\d+)@(\d{2})-(\d{2})-(\d{4})_(\d{2})-(\d{2})-(\d{2})$/i;
const PERSON_RE = /^(.+?)_(\d{2})_(\d+)$/u;
const EQUIPMENT_RE = /^EQ_([0-9a-f]{8})_(\d{2})_([0-9A-Za-z-]+)$/i;
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.heic', '.webp']);

function normalizeExtension(filenameOrExtension) {
  const value = String(filenameOrExtension || '');
  const ext = value.startsWith('.') && !value.includes('/') && !value.includes('\\')
    ? value
    : path.extname(value);
  return ext.toLowerCase();
}

function isImageFile(filename) {
  return IMAGE_EXTENSIONS.has(normalizeExtension(filename));
}

function isThumbnail(filename) {
  return /_thumb(?:\s*\(\d+\))?\.[^.]+$/i.test(filename) || /_thumb/i.test(filename);
}

function parseOriginalPhotoName(filename) {
  const extension = normalizeExtension(filename);
  const base = path.basename(filename, path.extname(filename));
  const match = base.match(ORIGINAL_RE);
  if (!match) return null;

  const [, photoNumber, day, month, year, hour, minute, second] = match;
  return {
    kind: 'original',
    photoNumber,
    day,
    month,
    year,
    hour,
    minute,
    second,
    extension,
    date: `${day}-${month}-${year}`,
    time: `${hour}-${minute}-${second}`,
    shotAt: `${year}-${month}-${day}T${hour}:${minute}:${second}`,
  };
}

function parsePersonPhotoName(filename) {
  const extension = normalizeExtension(filename);
  const base = path.basename(filename, path.extname(filename));
  const match = base.match(PERSON_RE);
  if (!match) return null;
  return {
    kind: 'person',
    person: match[1],
    day: match[2],
    photoNumber: match[3],
    extension,
  };
}

function parseEquipmentPhotoName(filename) {
  const extension = normalizeExtension(filename);
  const base = path.basename(filename, path.extname(filename));
  const match = base.match(EQUIPMENT_RE);
  if (!match) return null;
  return {
    kind: 'equipment',
    stableKey: match[1],
    day: match[2],
    photoNumber: match[3],
    extension,
  };
}

function safeDay(photo) {
  if (photo?.day) return String(photo.day).padStart(2, '0');
  if (photo?.shot_at) {
    const m = String(photo.shot_at).match(/^\d{4}-\d{2}-(\d{2})/);
    if (m) return m[1];
  }
  if (photo?.shotAt) {
    const m = String(photo.shotAt).match(/^\d{4}-\d{2}-(\d{2})/);
    if (m) return m[1];
  }
  return '00';
}

function photoNumberOf(photo) {
  return String(photo?.photo_number ?? photo?.photoNumber ?? 'NA');
}

function buildPersonFilename(person, photo, extension) {
  return `${person}_${safeDay(photo)}_${photoNumberOf(photo)}${normalizeExtension(extension || photo?.current_filename || photo?.original_filename || '.jpg')}`;
}

function buildEquipmentFilename(photo, extension) {
  const id = String(photo?.id || photo?.photo_id || '').replace(/[^0-9a-f]/gi, '').slice(0, 8).padEnd(8, '0');
  return `EQ_${id}_${safeDay(photo)}_${photoNumberOf(photo)}${normalizeExtension(extension || photo?.current_filename || photo?.original_filename || '.jpg')}`;
}

function comparePhotoNames(a, b) {
  const pa = parseOriginalPhotoName(a);
  const pb = parseOriginalPhotoName(b);
  if (pa && pb) {
    const dateA = `${pa.year}${pa.month}${pa.day}${pa.hour}${pa.minute}${pa.second}`;
    const dateB = `${pb.year}${pb.month}${pb.day}${pb.hour}${pb.minute}${pb.second}`;
    if (dateA !== dateB) return dateA.localeCompare(dateB);
    return Number(pa.photoNumber) - Number(pb.photoNumber);
  }
  if (pa) return -1;
  if (pb) return 1;
  return String(a).localeCompare(String(b), 'ru', { numeric: true, sensitivity: 'base' });
}

module.exports = {
  IMAGE_EXTENSIONS,
  isImageFile,
  isThumbnail,
  normalizeExtension,
  parseOriginalPhotoName,
  parsePersonPhotoName,
  parseEquipmentPhotoName,
  buildPersonFilename,
  buildEquipmentFilename,
  comparePhotoNames,
};
