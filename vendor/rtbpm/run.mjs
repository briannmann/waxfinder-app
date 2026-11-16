// usage: node run.mjs <sampleRate>   (mono f32le PCM on stdin) -> [{"tempo":..,"count":..,"confidence":..}, ...]
import {analyzeChannelData} from './node.mjs';
const chunks = []; for await (const c of process.stdin) chunks.push(c);
const b = Buffer.concat(chunks); const x = new Float32Array(b.buffer, b.byteOffset, Math.floor(b.length / 4));
let t = []; try { t = await analyzeChannelData(x, Number(process.argv[2]) || 44100); } catch (e) {}
console.log(JSON.stringify(t.slice(0, 3)));
