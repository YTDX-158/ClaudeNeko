// server/lib/zip.js — 手写 STORE 模式 zip 打包（零依赖）
// 用途：媒体批量下载。媒体（jpg/mp4/png 等）本就是压缩格式，用 STORE（不压缩）
// 只做容器即可，避免引入 archiver/jszip 依赖（保持"后端零依赖"卖点）。
// 手写 zip 结构：local file header × N + central directory × N + EOCD。
// 每个文件必须有 CRC-32（缺了解压软件报损坏），这里用查表法手写。

/** CRC-32 查表（预生成 256 项） */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

/** 计算 Buffer 的 CRC-32（返回无符号 32 位整数） */
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** 写小端序整数到 Buffer（写入长度由 size 决定，支持 2/4 字节） */
function writeUIntLE(buf, value, offset, size) {
  for (let i = 0; i < size; i++) {
    buf[offset + i] = value & 0xff;
    value >>>= 8;
  }
}

/**
 * 打包多个文件为 zip（STORE 模式）。
 * @param {Array<{name:string, data:Buffer}>} files 文件名 + 内容
 * @returns {Buffer} zip 二进制（可直接作响应体返回）
 */
export function createZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const encoder = new TextEncoder(); // UTF-8 文件名（中文不乱码）

  for (const f of files) {
    const nameBuf = Buffer.from(encoder.encode(f.name)); // TextEncoder 返回 Uint8Array，转 Buffer
    const nameLen = nameBuf.length;
    const data = f.data;
    const crc = crc32(data);
    const size = data.length;

    // --- Local File Header（30 字节 + 文件名） ---
    const lfh = Buffer.alloc(30 + nameLen);
    writeUIntLE(lfh, 0x04034b50, 0, 4); // 签名
    writeUIntLE(lfh, 20, 4, 2); // version needed（2.0 支持 UTF-8）
    lfh.writeUInt16LE(0x0800, 6); // general purpose flag：UTF-8 文件名
    lfh.writeUInt16LE(0, 8); // compression method：STORE（0=不压缩）
    writeUIntLE(lfh, 0, 10, 2); // mod time（0）
    writeUIntLE(lfh, 0, 12, 2); // mod date（0）
    writeUIntLE(lfh, crc, 14, 4); // CRC-32
    writeUIntLE(lfh, size, 18, 4); // 压缩后大小（STORE=原大小）
    writeUIntLE(lfh, size, 22, 4); // 原大小
    writeUIntLE(lfh, nameLen, 26, 2); // 文件名长度
    lfh.writeUInt16LE(0, 28); // 扩展字段长度
    nameBuf.copy(lfh, 30);

    // --- Central Directory Header（46 字节 + 文件名） ---
    const cdh = Buffer.alloc(46 + nameLen);
    writeUIntLE(cdh, 0x02014b50, 0, 4); // 签名
    writeUIntLE(cdh, 20, 4, 2); // version made by
    writeUIntLE(cdh, 20, 6, 2); // version needed
    cdh.writeUInt16LE(0x0800, 8); // UTF-8 flag
    cdh.writeUInt16LE(0, 10); // STORE
    writeUIntLE(cdh, 0, 12, 2); // mod time
    writeUIntLE(cdh, 0, 14, 2); // mod date
    writeUIntLE(cdh, crc, 16, 4);
    writeUIntLE(cdh, size, 20, 4);
    writeUIntLE(cdh, size, 24, 4);
    writeUIntLE(cdh, nameLen, 28, 2);
    cdh.writeUInt16LE(0, 30); // 扩展字段长度
    cdh.writeUInt16LE(0, 32); // 注释长度
    cdh.writeUInt16LE(0, 34); // 磁盘号
    cdh.writeUInt16LE(0, 36); // 内部属性
    writeUIntLE(cdh, 0, 38, 4); // 外部属性
    writeUIntLE(cdh, offset, 42, 4); // 本地头偏移
    nameBuf.copy(cdh, 46);

    localParts.push(lfh, data);
    centralParts.push(cdh);
    offset += lfh.length + data.length;
  }

  // --- EOCD（22 字节） ---
  const centralSize = centralParts.reduce((s, p) => s + p.length, 0);
  const centralOffset = offset;
  const count = files.length;
  const eocd = Buffer.alloc(22);
  writeUIntLE(eocd, 0x06054b50, 0, 4); // 签名
  eocd.writeUInt16LE(0, 4); // 磁盘号
  eocd.writeUInt16LE(0, 6); // 中央目录起始磁盘
  eocd.writeUInt16LE(count, 8); // 本磁盘条目数
  eocd.writeUInt16LE(count, 10); // 总条目数
  writeUIntLE(eocd, centralSize, 12, 4); // 中央目录大小
  writeUIntLE(eocd, centralOffset, 16, 4); // 中央目录偏移
  eocd.writeUInt16LE(0, 20); // 注释长度

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}
