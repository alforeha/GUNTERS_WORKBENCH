// src/core/detect.ts — format sniffing for the import pipeline (docs/06 D2).
// Pure core code: no DOM APIs required for the Node-testable path. Content-first,
// extension as fallback — Carlson exports LandXML with a .XML extension, and users
// rename files, so bytes always win over names.

export type DetectedFormat = 'landxml' | 'carlson-dtm' | 'dxf' | 'dwg' | 'geotiff' | 'pdf' | 'las' | 'unknown';

/** Node-testable input: a name plus the first bytes (≥4 KB recommended). */
export interface SniffSample {
  name: string;
  firstBytes: Uint8Array | string;
}

export const SNIFF_BYTES = 4096;

/** What each rule looks for — surfaced by the import UI for 'unknown' files. */
export const SNIFF_RULES: ReadonlyArray<{ format: DetectedFormat; lookedFor: string }> = [
  { format: 'landxml', lookedFor: '"<LandXML" within the first 4 KB' },
  { format: 'carlson-dtm', lookedFor: '"#Carlson DTM" magic' },
  { format: 'dxf', lookedFor: 'DXF "0/SECTION" or AutoCAD header' },
  { format: 'dwg', lookedFor: '"AC10xx" DWG binary magic' },
  { format: 'geotiff', lookedFor: 'TIFF byte-order magic ("II*\\0" or "MM\\0*")' },
  { format: 'pdf', lookedFor: 'PDF "%PDF-" magic' },
  { format: 'las', lookedFor: 'LAS "LASF" signature' },
];

// Latin-1 view of the head bytes: keeps ASCII landmarks intact without UTF-8 mangling
// of binary content.
function headText(bytes: Uint8Array | string): string {
  if (typeof bytes === 'string') return bytes.slice(0, SNIFF_BYTES);
  const n = Math.min(bytes.length, SNIFF_BYTES);
  let out = '';
  for (let i = 0; i < n; i++) out += String.fromCharCode(bytes[i] as number);
  return out;
}

const DXF_SENTINEL = /(^|\r?\n)[ \t]*0[ \t]*\r?\n[ \t]*SECTION/;
const DWG_MAGIC = /^AC10\d\d/;

function hasTiffMagic(text: string): boolean {
  return (
    (text.charCodeAt(0) === 0x49 &&
      text.charCodeAt(1) === 0x49 &&
      text.charCodeAt(2) === 0x2a &&
      text.charCodeAt(3) === 0x00) ||
    (text.charCodeAt(0) === 0x4d &&
      text.charCodeAt(1) === 0x4d &&
      text.charCodeAt(2) === 0x00 &&
      text.charCodeAt(3) === 0x2a)
  );
}

function detect(name: string, text: string): DetectedFormat {
  // content-first
  if (text.includes('<LandXML')) return 'landxml'; // regardless of extension (Carlson emits .XML)
  if (text.includes('#Carlson DTM')) return 'carlson-dtm';
  if (DXF_SENTINEL.test(text) || text.includes('AutoCAD')) return 'dxf';
  if (DWG_MAGIC.test(text)) return 'dwg';
  if (hasTiffMagic(text)) return 'geotiff';
  if (text.startsWith('%PDF-')) return 'pdf';
  if (text.startsWith('LASF')) return 'las';
  // extension fallback
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'xml') return 'landxml';
  if (ext === 'tin') return 'carlson-dtm';
  if (ext === 'dxf') return 'dxf';
  if (ext === 'dwg') return 'dwg';
  if (ext === 'tif' || ext === 'tiff' || ext === 'geotiff') return 'geotiff';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'las') return 'las';
  return 'unknown';
}

/**
 * Sniff a file's format. Sync for {name, firstBytes} (Node-testable);
 * async for File/Blob (the browser slice read is inherently async).
 */
export function sniffFormat(file: SniffSample): DetectedFormat;
export function sniffFormat(file: File): Promise<DetectedFormat>;
export function sniffFormat(file: File | SniffSample): DetectedFormat | Promise<DetectedFormat> {
  if ('firstBytes' in file) return detect(file.name, headText(file.firstBytes));
  return file
    .slice(0, SNIFF_BYTES)
    .arrayBuffer()
    .then((buf) => detect(file.name, headText(new Uint8Array(buf))));
}
