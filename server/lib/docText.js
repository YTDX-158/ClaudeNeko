import zlib from 'node:zlib';

/**
 * docText.js — 文档抽文字（零依赖，供纯文本主模型读取文档内容）
 * 支持：txt/md 直接读；pdf 抽文本流；docx 解 zip 抽 <w:t>。
 * 注意：入参为 buffer（调用方异步读入），本模块不做同步文件 I/O。
 */

const MAX_TEXT = 6000; // 单文档最多进 prompt 的字符数

/** 抽文档文字；失败/不支持返回 null。 */
export function extractDocumentText(buf, ext) {
  try {
    if (ext === 'txt' || ext === 'md') return buf.toString('utf8').slice(0, MAX_TEXT);
    if (ext === 'pdf') return extractPdfText(buf);
    if (ext === 'docx') return extractDocxText(buf);
  } catch {
    // 解析失败返回 null
  }
  return null;
}

/** 从 PDF 流里抽 BT...ET 的文本（简化实现，够用于读文字性文档）。 */
function extractPdfText(buf) {
  const content = buf.toString('latin1');
  const texts = [];
  // 常见文本算子：(...) Tj 和 [...] TJ
  const re = /\(((?:[^()\\]|\\.)*)\)\s*Tj|\[((?:[^\]\\]|\\.)*)\]\s*TJ/g;
  let m;
  while ((m = re.exec(content))) {
    const raw = m[1] !== undefined ? m[1] : m[2];
    const t = raw.replace(/\\([()\\])/g, '$1');
    if (t.trim()) texts.push(t);
    if (texts.join('').length > MAX_TEXT) break;
  }
  return texts.join(' ').slice(0, MAX_TEXT) || null;
}

/** docx = zip，解出 word/document.xml 再抽 <w:t> 文字。 */
function extractDocxText(buf) {
  let offset = 0;
  let docXml = null;
  // 简易 ZIP 解析：遍历 Local File Header，找 word/document.xml
  while (offset + 30 <= buf.length) {
    if (buf.readUInt32LE(offset) !== 0x04034b50) break; // PK\x03\x04
    const method = buf.readUInt16LE(offset + 8);
    const compSize = buf.readUInt32LE(offset + 18);
    const nameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const name = buf.toString('utf8', offset + 30, offset + 30 + nameLen);
    const dataStart = offset + 30 + nameLen + extraLen;
    if (name === 'word/document.xml') {
      const comp = buf.subarray(dataStart, dataStart + compSize);
      docXml = method === 0 ? comp.toString('utf8') : zlib.inflateRawSync(comp).toString('utf8');
      break;
    }
    offset = dataStart + compSize;
  }
  if (!docXml) return null;
  const texts = [...docXml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((mm) => mm[1]);
  return texts.join('').slice(0, MAX_TEXT) || null;
}
