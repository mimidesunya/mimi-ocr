const fs = require('fs');
const path = require('path');

function pad2(value) {
    return String(value).padStart(2, '0');
}

function buildShortTimestamp(date) {
    const year = pad2(date.getFullYear() % 100);
    const month = pad2(date.getMonth() + 1);
    const day = pad2(date.getDate());
    const hour = pad2(date.getHours());
    const minute = pad2(date.getMinutes());
    const second = pad2(date.getSeconds());
    return `${year}${month}${day}-${hour}${minute}${second}`;
}

const outputPath = process.argv[2];
if (!outputPath) {
    console.error('Usage: node scripts/write_build_info.js <output-json-path>');
    process.exit(1);
}

const now = new Date();
const buildInfo = {
    number: buildShortTimestamp(now),
    timestamp: now.toISOString()
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(buildInfo, null, 2) + '\n', 'utf-8');
console.log(`[build] build number: ${buildInfo.number}`);
