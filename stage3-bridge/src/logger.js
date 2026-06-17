function stamp() {
  return new Date().toISOString();
}

function log(level, message, meta) {
  const extra = meta ? ` ${JSON.stringify(meta)}` : '';
  const line = `[${stamp()}] [${level}] ${message}${extra}`;
  if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
}

module.exports = {
  info: (message, meta) => log('info', message, meta),
  warn: (message, meta) => log('warn', message, meta),
  error: (message, meta) => log('error', message, meta)
};
