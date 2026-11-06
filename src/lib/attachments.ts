import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";

export type AttachmentDescriptor = {
  groupId: string;
  fileName: string;
  kind: "image" | "document" | "video";
  mimeType: string;
  frameIndex?: number;
  frameTime?: number;
};

export type ProcessedAttachment = AttachmentDescriptor & {
  fileName: string;
  mimeType: string;
  byteSize: number;
  data: Uint8Array | null;
  extractedText: string | null;
};

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const DOCUMENT_EXTENSIONS = new Set(["pdf", "docx", "txt", "md", "csv", "json"]);
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_EXTRACTED_CHARS = 40_000;

export function safeFileName(fileName: string) {
  const baseName = fileName.split(/[\\/]/).pop() || "attachment";
  return baseName.replace(/[^\p{L}\p{N}._() -]/gu, "_").slice(0, 180) || "attachment";
}

function hasImageSignature(bytes: Uint8Array, mimeType: string) {
  if (mimeType === "image/png") return bytes.length > 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value);
  if (mimeType === "image/jpeg") return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === "image/gif") return new TextDecoder().decode(bytes.slice(0, 6)).startsWith("GIF8");
  if (mimeType === "image/webp") return new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP";
  return false;
}

async function extractDocument(fileName: string, bytes: Uint8Array) {
  const extension = fileName.split(".").pop()?.toLowerCase() || "";
  let text = "";
  if (extension === "pdf") {
    if (new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") throw new Error(`${fileName} is not a valid PDF file.`);
    const parser = new PDFParse({ data: bytes });
    try {
      const result = await parser.getText();
      text = result.text;
    } finally {
      await parser.destroy();
    }
  } else if (extension === "docx") {
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error(`${fileName} is not a valid DOCX file.`);
    const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    text = result.value;
  } else {
    text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }

  text = text.replace(/\u0000/g, "").trim();
  if (!text) throw new Error(`${fileName} contains no extractable text. Scanned PDFs need OCR, which is not included yet.`);
  return text.length > MAX_EXTRACTED_CHARS ? `${text.slice(0, MAX_EXTRACTED_CHARS)}\n\n[Document text was shortened to fit the chat context.]` : text;
}

export async function processAttachment(file: File, descriptor: AttachmentDescriptor): Promise<ProcessedAttachment> {
  const fileName = safeFileName(descriptor.fileName);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mimeType = descriptor.mimeType.toLowerCase();

  if (descriptor.kind === "image" || descriptor.kind === "video") {
    if (!IMAGE_TYPES.has(mimeType)) throw new Error(`${fileName} has an unsupported image format. Use PNG, JPEG, GIF, or WebP.`);
    const limit = descriptor.kind === "video" ? MAX_FRAME_BYTES : MAX_IMAGE_BYTES;
    if (bytes.byteLength > limit) throw new Error(`${fileName} is over the ${Math.floor(limit / 1024 / 1024)} MB limit.`);
    if (!hasImageSignature(bytes, mimeType)) throw new Error(`${fileName} does not appear to be a valid ${mimeType} image.`);
    return { ...descriptor, fileName, mimeType, byteSize: bytes.byteLength, data: bytes, extractedText: null };
  }

  if (bytes.byteLength > MAX_DOCUMENT_BYTES) throw new Error(`${fileName} is over the 10 MB document limit.`);
  const extension = fileName.split(".").pop()?.toLowerCase() || "";
  if (!DOCUMENT_EXTENSIONS.has(extension)) throw new Error(`${fileName} is not a supported document. Use PDF, DOCX, TXT, MD, CSV, or JSON.`);
  const extractedText = await extractDocument(fileName, bytes);
  return { ...descriptor, fileName, mimeType: extension === "pdf" ? "application/pdf" : extension === "docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : "text/plain", byteSize: bytes.byteLength, data: null, extractedText };
}
