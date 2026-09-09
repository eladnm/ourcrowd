/**
 * Console logging with timestamps. The pipeline is a CLI a human watches run,
 * so readable lines matter more than structured output here.
 */
const stamp = () => new Date().toISOString().slice(11, 19);

export const log = {
  info: (msg: string) => console.log(`[${stamp()}] ${msg}`),
  warn: (msg: string) => console.warn(`[${stamp()}] WARN  ${msg}`),
  error: (msg: string) => console.error(`[${stamp()}] ERROR ${msg}`),
  step: (msg: string) => console.log(`\n[${stamp()}] === ${msg} ===`),
};
