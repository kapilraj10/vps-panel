// Minimal UDP DNS server for tests: answers A and TXT questions from a JS object { 'name': { A: ['1.2.3.4'], TXT: ['x'] } }.
import dgram from 'node:dgram';

function readName(buf, off) {
  const labels = [];
  for (;;) {
    const len = buf[off];
    if (len === 0) return { name: labels.join('.').toLowerCase(), off: off + 1 };
    labels.push(buf.toString('ascii', off + 1, off + 1 + len));
    off += len + 1;
  }
}

export function startFakeDns(records) {
  const sock = dgram.createSocket('udp4');
  sock.on('message', (msg, rinfo) => {
    const { name, off } = readName(msg, 12);
    const type = msg.readUInt16BE(off);
    const question = msg.subarray(12, off + 4);
    const rec = records[name] || {};
    const answers = [];
    if (type === 1) for (const ip of rec.A || []) answers.push({ type: 1, data: Buffer.from(ip.split('.').map(Number)) });
    if (type === 16) for (const t of rec.TXT || []) { const b = Buffer.from(t); answers.push({ type: 16, data: Buffer.concat([Buffer.from([b.length]), b]) }); }
    const head = Buffer.alloc(12);
    msg.copy(head, 0, 0, 2); // id
    head.writeUInt16BE(0x8180 | (answers.length || records[name] ? 0 : 3), 2); // response, recursion; NXDOMAIN when unknown
    head.writeUInt16BE(1, 4);
    head.writeUInt16BE(answers.length, 6);
    const parts = [head, question];
    for (const a of answers) {
      const rr = Buffer.alloc(12);
      rr.writeUInt16BE(0xc00c, 0); rr.writeUInt16BE(a.type, 2); rr.writeUInt16BE(1, 4); rr.writeUInt32BE(30, 6); rr.writeUInt16BE(a.data.length, 10);
      parts.push(rr, a.data);
    }
    sock.send(Buffer.concat(parts), rinfo.port, rinfo.address);
  });
  return new Promise((resolve) => sock.bind(0, '127.0.0.1', () => resolve({ port: sock.address().port, records, close: () => sock.close() })));
}
