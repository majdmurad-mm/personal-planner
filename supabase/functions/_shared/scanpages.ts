// Scanned pages as pictures, for Claude to read. A scanned PDF stores each page as an image; this takes the
// page's largest image out of the file without drawing anything (cheap enough for an edge function):
//   JPEG (DCTDecode)            → handed over as it is
//   Flate-compressed pixels     → wrapped as a PNG (grey or RGB, 1 or 8 bits)
//   CCITT fax, JBIG2, JPEG 2000 → not readable this way; reported per page
// Plain image files (JPEG, PNG) pass straight through. Nothing is stored; the caller decides what to keep.
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFNumber, PDFRawStream, PDFRef } from "pdf-lib";
import { unzlibSync, zlibSync } from "fflate";

export type ScanPage = { page: number; mime?: "image/jpeg" | "image/png"; data?: Uint8Array; width?: number; height?: number; why?: string };
export const MAX_IMAGE_BYTES = 3_600_000;       // a page larger than this is skipped (Claude's limit is about 5 MB once encoded)

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(parts: Uint8Array[]) { let c = 0xffffffff; for (const p of parts) for (let i = 0; i < p.length; i++) c = CRC[(c ^ p[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type: string, body: Uint8Array) {
  const t = new TextEncoder().encode(type), out = new Uint8Array(12 + body.length), dv = new DataView(out.buffer);
  dv.setUint32(0, body.length); out.set(t, 4); out.set(body, 8); dv.setUint32(8 + body.length, crc32([t, body])); return out;
}
/** A PNG from zlib-compressed rows that already start with a filter byte each. */
export function pngFromIdat(w: number, h: number, bits: number, colorType: 0 | 2, idat: Uint8Array) {
  const ih = new Uint8Array(13), dv = new DataView(ih.buffer); dv.setUint32(0, w); dv.setUint32(4, h); ih[8] = bits; ih[9] = colorType;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ih), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out;
}

// deno-lint-ignore no-explicit-any
const num = (v: any) => (v instanceof PDFNumber ? v.asNumber() : null);
// deno-lint-ignore no-explicit-any
function filters(d: PDFDict): string[] { const f: any = d.lookup(PDFName.of("Filter")); if (!f) return []; if (f instanceof PDFName) return [f.decodeText()]; if (f instanceof PDFArray) return f.asArray().map((x: any) => (x instanceof PDFName ? x.decodeText() : "")); return []; }
// deno-lint-ignore no-explicit-any
function parms(d: PDFDict): PDFDict | null { const p: any = d.lookup(PDFName.of("DecodeParms")); if (p instanceof PDFDict) return p; if (p instanceof PDFArray) { const x = p.lookup(p.size() - 1); return x instanceof PDFDict ? x : null; } return null; }
/** colour components of an image: 1 grey, 3 RGB, 4 CMYK, 0 unknown/indexed */
// deno-lint-ignore no-explicit-any
function comps(doc: PDFDocument, d: PDFDict): number {
  if (d.lookup(PDFName.of("ImageMask"))?.toString() === "true") return 1;
  // deno-lint-ignore no-explicit-any
  let cs: any = d.lookup(PDFName.of("ColorSpace"));
  if (cs instanceof PDFName) return ({ DeviceGray: 1, CalGray: 1, DeviceRGB: 3, CalRGB: 3, DeviceCMYK: 4 } as Record<string, number>)[cs.decodeText()] || 0;
  if (cs instanceof PDFArray) {
    const kind = cs.lookup(0); const k = kind instanceof PDFName ? kind.decodeText() : "";
    if (k === "ICCBased") { const s = cs.lookup(1); const n = s && "dict" in s ? num((s as PDFRawStream).dict.lookup(PDFName.of("N"))) : null; return n || 0; }
    if (k === "CalGray") return 1; if (k === "CalRGB") return 3;
  }
  return 0;
}
/** One image stream → JPEG or PNG bytes, or the reason it can't be. */
export function imageOf(doc: PDFDocument, s: PDFRawStream): { mime?: "image/jpeg" | "image/png"; data?: Uint8Array; width: number; height: number; why?: string } {
  const d = s.dict, w = num(d.lookup(PDFName.of("Width"))) || 0, h = num(d.lookup(PDFName.of("Height"))) || 0, f = filters(d);
  const last = f[f.length - 1] || "";
  if (last === "DCTDecode") {
    let data = s.contents; if (f.length === 2 && f[0] === "FlateDecode") data = unzlibSync(data); else if (f.length > 1) return { width: w, height: h, why: "packed in an unusual way" };
    if (comps(doc, d) === 4) return { width: w, height: h, why: "a CMYK JPEG, which Claude may show with odd colours", mime: "image/jpeg", data };
    return { mime: "image/jpeg", data, width: w, height: h };
  }
  if (last === "CCITTFaxDecode") return { width: w, height: h, why: "a black-and-white fax-style scan (CCITT), which cannot be passed on as a picture" };
  if (last === "JBIG2Decode") return { width: w, height: h, why: "a black-and-white JBIG2 scan, which cannot be passed on as a picture" };
  if (last === "JPXDecode") return { width: w, height: h, why: "a JPEG 2000 scan, which cannot be passed on as a picture" };
  if (f.length > 1 || (f.length === 1 && last !== "FlateDecode")) return { width: w, height: h, why: "packed in an unusual way (" + f.join(", ") + ")" };
  const n = comps(doc, d), bits = num(d.lookup(PDFName.of("BitsPerComponent"))) || (d.lookup(PDFName.of("ImageMask")) ? 1 : 8);
  if (n !== 1 && n !== 3) return { width: w, height: h, why: n === 4 ? "a CMYK image" : "an image with a colour palette" };
  if (!(bits === 8 || (bits === 1 && n === 1))) return { width: w, height: h, why: bits + "-bit colour" };
  const p = parms(d), pred = p ? num(p.lookup(PDFName.of("Predictor"))) || 1 : 1;
  const dec = d.lookup(PDFName.of("Decode")), inverted = dec instanceof PDFArray && num(dec.lookup(0)) === 1;
  const rowBytes = Math.ceil(w * n * bits / 8), ct = (n === 1 ? 0 : 2) as 0 | 2;
  if (!f.length) return { width: w, height: h, why: "stored without compression" };
  if (pred >= 10 && !inverted) return { mime: "image/png", data: pngFromIdat(w, h, bits, ct, s.contents), width: w, height: h };   // PNG rows already
  if (pred !== 1 && pred < 10) return { width: w, height: h, why: "TIFF-predicted pixels" };
  const raw = unzlibSync(s.contents);
  if (pred >= 10) {   // inverted and PNG-predicted: rare, decode would be needed
    return { width: w, height: h, why: "inverted PNG-predicted pixels" };
  }
  if (raw.length < rowBytes * h) return { width: w, height: h, why: "the picture data is shorter than it says" };
  const rows = new Uint8Array((rowBytes + 1) * h);
  for (let y = 0; y < h; y++) { rows[y * (rowBytes + 1)] = 0; const src = raw.subarray(y * rowBytes, (y + 1) * rowBytes); if (inverted) for (let i = 0; i < rowBytes; i++) rows[y * (rowBytes + 1) + 1 + i] = src[i] ^ 0xff; else rows.set(src, y * (rowBytes + 1) + 1); }
  return { mime: "image/png", data: pngFromIdat(w, h, bits, ct, zlibSync(rows, { level: 6 })), width: w, height: h };
}
/** The image streams drawn on a page (one level of forms included), largest first. */
function pageImages(doc: PDFDocument, res: PDFDict | undefined, depth = 0): PDFRawStream[] {
  const out: PDFRawStream[] = []; if (!res) return out;
  const xo = res.lookup(PDFName.of("XObject")); if (!(xo instanceof PDFDict)) return out;
  for (const [, ref] of xo.entries()) {
    const s = ref instanceof PDFRef ? doc.context.lookup(ref) : ref;
    if (!(s instanceof PDFRawStream)) continue;
    const st = s.dict.lookup(PDFName.of("Subtype")), kind = st instanceof PDFName ? st.decodeText() : "";
    if (kind === "Image") out.push(s);
    else if (kind === "Form" && depth < 2) { const r = s.dict.lookup(PDFName.of("Resources")); out.push(...pageImages(doc, r instanceof PDFDict ? r : undefined, depth + 1)); }
  }
  const area = (s: PDFRawStream) => (num(s.dict.lookup(PDFName.of("Width"))) || 0) * (num(s.dict.lookup(PDFName.of("Height"))) || 0);
  return out.sort((a, b) => area(b) - area(a));
}
/** Open a PDF; null when it can't be parsed (damaged or encrypted). */
export async function openPdf(bytes: Uint8Array): Promise<PDFDocument | null> {
  try { return await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false }); } catch { return null; }
}
/** The given pages (1-based) of a PDF as pictures, each with its reason when it can't be given. */
export function scanPages(doc: PDFDocument, pages: number[]): ScanPage[] {
  const all = doc.getPages();
  return pages.map((p) => {
    const pg = all[p - 1]; if (!pg) return { page: p, why: "there is no such page" };
    const imgs = pageImages(doc, pg.node.Resources());
    if (!imgs.length) return { page: p, why: "this page has no picture on it (it is text or drawing, so it should already have text)" };
    const r = imageOf(doc, imgs[0]);
    if (r.data && r.data.length > MAX_IMAGE_BYTES) return { page: p, width: r.width, height: r.height, why: "the scan is too large to pass on (" + Math.round(r.data.length / 1e5) / 10 + " MB)" };
    const tiny = r.width * r.height < 200 * 200;
    if (r.data && tiny) return { page: p, why: "the only picture on this page is tiny (a logo or stamp), not a scanned page" };
    return { page: p, mime: r.mime, data: r.data, width: r.width, height: r.height, why: r.data ? (r.why || undefined) : r.why };
  });
}
/** Is this file a picture Claude can take as it is? */
export function imageFileMime(bytes: Uint8Array): "image/jpeg" | "image/png" | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  return null;
}
export const isPdf = (bytes: Uint8Array) => bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
/** base64 without blowing the stack on big images */
export function b64(u: Uint8Array) { let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); }
