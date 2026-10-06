// Packs the project into MeetMinder-Mac.zip for copying to a Mac: `npm run zip:mac`.
// Only files tracked by git are included (node_modules, dist and .tools are left out; `git add`
// new files first). Unix permissions come from git, so "Build MeetMinder.command" stays
// double-clickable after macOS unzips it.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');

const repoDir = path.join(__dirname, '..');
const outFile = path.join(repoDir, 'MeetMinder-Mac.zip');
const topFolder = 'MeetMinder';

// One "<mode> <object> <stage>\t<path>" line per tracked file.
const entries = execFileSync('git', ['ls-files', '-s', '-z'], { cwd: repoDir })
  .toString('utf8')
  .split('\0')
  .filter(Boolean)
  .map((line) => {
    const [meta, rel] = line.split('\t');
    return { rel, mode: parseInt(meta.split(' ')[0], 8) };
  });

function dosDateTime(date) {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    day: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

const chunks = [];
const central = [];
let offset = 0;

for (const { rel, mode } of entries) {
  const file = path.join(repoDir, rel);
  const data = fs.readFileSync(file);
  const name = Buffer.from(`${topFolder}/${rel}`, 'utf8');
  const deflated = zlib.deflateRawSync(data, { level: 9 });
  const method = deflated.length < data.length ? 8 : 0;
  const body = method === 8 ? deflated : data;
  const crc = zlib.crc32(data);
  const { time, day } = dosDateTime(fs.statSync(file).mtime);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed to extract
  local.writeUInt16LE(0x0800, 6); // UTF-8 file names
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(day, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  chunks.push(local, name, body);

  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(0x0314, 4); // made by Unix, zip spec 2.0: macOS honours the permissions
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(method, 10);
  header.writeUInt16LE(time, 12);
  header.writeUInt16LE(day, 14);
  header.writeUInt32LE(crc, 16);
  header.writeUInt32LE(body.length, 20);
  header.writeUInt32LE(data.length, 24);
  header.writeUInt16LE(name.length, 28);
  header.writeUInt32LE(0, 30); // extra field + comment lengths
  header.writeUInt32LE(0, 34); // disk number + internal attributes
  header.writeUInt32LE(((mode & 0o177777) << 16) >>> 0, 38); // Unix mode, e.g. 0100755
  header.writeUInt32LE(offset, 42);
  central.push(header, name);
  offset += local.length + name.length + body.length;
}

const directory = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(entries.length, 8);
end.writeUInt16LE(entries.length, 10);
end.writeUInt32LE(directory.length, 12);
end.writeUInt32LE(offset, 16);
fs.writeFileSync(outFile, Buffer.concat([...chunks, directory, end]));
console.log(`Created ${outFile} (${entries.length} files, ${Math.round(fs.statSync(outFile).size / 1024)} KB)`);
