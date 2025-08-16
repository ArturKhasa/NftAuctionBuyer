#!/usr/bin/env node
/**
 * Getgems TON Auction Snipe Bot — +N TON above current
 * -------------------------------------------------------------
 * Назначение: в заданный момент времени делает ставку на аукционе Getgems
 * ровно на N TON выше текущей максимальной ставки.
 *
 * Пример:
 *   node getgems-ton-bid-bot.js \
 *     --to EQC...AUCTION_CONTRACT... \
 *     --over 0.2 \
 *     --when 2025-08-20T22:59:58+03:00
 *
 * .env:
 *   MNEMONIC="word1 word2 ... word24"
 *   TON_RPC=https://toncenter.com/api/v2/jsonRPC
 *   TONCENTER_API_KEY=... (рекомендуется)
 */

import 'dotenv/config';
import { Command } from 'commander';
import { TonClient, WalletContractV4, internal } from '@ton/ton';
import { beginCell, Address, toNano } from '@ton/core';
import { mnemonicToPrivateKey } from '@ton/crypto';

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// Minimal CRC32 implementation to compute opcodes like crc32("process_ton_bid")
function crc32(str) {
  let c = ~0;
  for (let i = 0; i < str.length; i++) {
    c ^= str.charCodeAt(i);
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
    }
  }
  return ~c >>> 0; // unsigned
}

// Helper utilities for retries and error introspection
function safeStringify(obj) {
  try {
    const seen = new WeakSet();
    return JSON.stringify(
      obj,
      (k, v) => {
        if (typeof v === 'bigint') return v.toString();
        if (typeof v === 'object' && v !== null) {
          if (seen.has(v)) return undefined;
          seen.add(v);
        }
        return v;
      },
      2
    );
  } catch {
    return String(obj);
  }
}

function extractHttpStatus(err) {
  return {
    status: err?.response?.status || err?.status,
    statusText: err?.response?.statusText,
    data: err?.response?.data,
    headers: err?.response?.headers,
    code: err?.code,
  };
}

function parseDecimal(v) { return parseFloat(String(v).replace(',', '.')); }

async function withRetries(fn, label = 'request', max = 5) {
  let delay = 500;
  for (let i = 0; i < max; i++) {
    try {
      return await fn();
    } catch (err) {
      const { status, code, headers } = extractHttpStatus(err);
      const retryAfter = Number(headers?.['retry-after']);
      const transient =
        status === 429 || status === 502 || status === 503 || status === 504 ||
        code === 'ETIMEDOUT' || code === 'ECONNRESET';
      if (!transient || i === max - 1) throw err;
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : delay;
      console.warn(`[${label}] ${status || code} — retry ${i + 1}/${max - 1} in ${wait}ms`);
      await sleep(wait);
      delay = Math.min(delay * 2, 5000);
    }
  }
}

// Getgems auction opcodes (derived via CRC32 of their strings)
const OPCODES = {
  process_ton_bid: crc32('process_ton_bid'),
};

function must(v, name) {
  const isEmptyString = typeof v === 'string' && v.trim() === '';
  if (v === undefined || v === null || isEmptyString) throw new Error(`Missing ${name}`);
  return v;
}

async function buildClient() {
  const endpoint = process.env.TON_RPC || 'https://toncenter.com/api/v2/jsonRPC';
  const apiKey = process.env.TONCENTER_API_KEY || undefined;
  return new TonClient({ endpoint, apiKey });
}

async function buildWallet(client) {
  const mnemonic = must(process.env.MNEMONIC, 'MNEMONIC');
  const { publicKey, secretKey } = await mnemonicToPrivateKey(mnemonic.trim().split(/\s+/));
  const wallet = WalletContractV4.create({ publicKey, workchain: 0 });
  const opened = client.open(wallet);
  return { wallet: opened, secretKey };
}

function parseWhen(whenStr) {
  const t = new Date(whenStr);
  if (Number.isNaN(t.getTime())) throw new Error(`Invalid --when value. Use ISO like 2025-08-20T22:59:58+03:00`);
  return t;
}

async function waitUntil(target) {
  const now = new Date();
  const ms = target.getTime() - now.getTime();
  if (ms <= 0) return; // run immediately if time has passed
  // Sleep in chunks to keep process responsive
  const step = 1000;
  let left = ms;
  while (left > 0) {
    const chunk = Math.min(step, left);
    await sleep(chunk);
    left -= chunk;
  }
}

function pickQueryId() {
  // 64-bit random-ish query id
  const hi = Math.floor(Math.random() * 0xffffffff);
  const lo = Math.floor(Math.random() * 0xffffffff);
  // combine into BigInt
  return (BigInt(hi) << 32n) | BigInt(lo);
}

async function sendMessages(wallet, secretKey, messages) {
  const seqno = await withRetries(() => wallet.getSeqno(), 'getSeqno');
  await withRetries(() => wallet.sendTransfer({ seqno, secretKey, messages }), 'sendTransfer');
}


function makeAuctionBidMessage(auctionAddr, amountTon) {
  const to = Address.parse(auctionAddr);
  const value = toNano(amountTon.toString());
  const payload = beginCell().storeUint(OPCODES.process_ton_bid, 32).storeUint(pickQueryId(), 64).endCell();
  return internal({ to, value, bounce: true, body: payload });
}

// --- Relative bidding helpers ---
function deriveToncenterRestBase() {
  // TON_RPC usually like: https://toncenter.com/api/v2/jsonRPC
  const raw = process.env.TON_RPC || 'https://toncenter.com/api/v2/jsonRPC';
  try {
    const u = new URL(raw);
    // strip trailing /jsonRPC
    u.pathname = u.pathname.replace(/\/jsonRPC$/i, '');
    return u.toString().replace(/\/$/, ''); // no trailing slash
  } catch {
    return 'https://toncenter.com/api/v2';
  }
}

async function fetchLastBidFromToncenter(auctionAddr, limit = 25, verbose = false) {
  // Heuristic: find latest inbound tx to auction with opcode = process_ton_bid and take its value
  const base = deriveToncenterRestBase();
  const apiKey = process.env.TONCENTER_API_KEY;
  const url = `${base}/getTransactions?address=${encodeURIComponent(auctionAddr)}&limit=${limit}${apiKey ? `&api_key=${apiKey}` : ''}`;
  if (verbose) console.log('[rpc] GET', url);
  const res = await withRetries(() => fetch(url).then(r => {
    if (!r.ok) throw new Error(`toncenter getTransactions HTTP ${r.status}`);
    return r.json();
  }), 'getTransactions');
  const txs = res?.result || [];
  const opcode = OPCODES.process_ton_bid >>> 0; // uint32
  const isBidMsg = (b64) => {
    try {
      if (!b64) return false;
      const buf = Buffer.from(b64, 'base64');
      if (buf.length < 4) return false;
      // BE uint32
      const code = (buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3];
      return (code >>> 0) === opcode;
    } catch { return false; }
  };
  for (const tx of txs) {
    const inMsg = tx?.in_msg;
    if (!inMsg) continue;
    if (isBidMsg(inMsg?.msg_data?.body) || isBidMsg(inMsg?.boc)) {
      const nano = BigInt(inMsg.value || inMsg?.info?.value || 0);
      if (nano > 0n) return Number(nano) / 1e9;
    }
  }
  // Fallback: first inbound with positive value
  for (const tx of txs) {
    const inMsg = tx?.in_msg;
    const nano = BigInt(inMsg?.value || inMsg?.info?.value || 0);
    if (nano > 0n) return Number(nano) / 1e9;
  }
  return null;
}







async function main() {
  const program = new Command();
  program
    .requiredOption('--to <address>', 'Auction contract address (not the NFT item)')
    .requiredOption('--when <ISO8601>', 'When to execute, e.g. 2025-08-20T22:59:58+03:00')
    .requiredOption('--over <TON>', 'Bid OVER current highest, TON', parseDecimal)
    .option('--verbose', 'Verbose logging', false)
    .option('--dry-run', 'Do not send tx, only print computed bid', false)
    .parse(process.argv);

  const opts = program.opts();
  const when = parseWhen(opts.when);
  const client = await buildClient();
  const { wallet, secretKey } = await buildWallet(client);

  console.log(`[+] Waiting until ${when.toISOString()} to place auction bid...`);
  await waitUntil(when);

  console.log('[i] Fetching latest bid from TonCenter ...');
  const current = await fetchLastBidFromToncenter(opts.to, 25, !!opts.verbose);
  if (!Number.isFinite(current)) {
    throw new Error('Could not determine current highest bid from transactions.');
  }
  console.log(`[i] Current highest bid ≈ ${current} TON`);
  const bidAmount = Math.round((current + Number(opts.over)) * 1e9) / 1e9;
  if (!(bidAmount > current)) {
    throw new Error(`Computed bid (${bidAmount} TON) must be greater than current (${current} TON). Increase --over.`);
  }
  console.log(`[i] Final bid amount: ${bidAmount} TON`);
  if (opts.dryRun) { console.log('[dry-run] Would send bid now. Exiting.'); return; }
  const msg = makeAuctionBidMessage(opts.to, bidAmount);
  console.log(`[>] Sending BID of ${bidAmount} TON to auction ${opts.to} ...`);
  await sendMessages(wallet, secretKey, [msg]);
  console.log('[✔] Bid transaction submitted.');

  // Optional: tiny delay to let seqno advance before script exits
  await sleep(1000);
}

main().catch((err) => {
  try {
    console.error('Error:', err?.message || err);
    const details = {
      name: err?.name,
      ...extractHttpStatus(err),
      cause: err?.cause && (err.cause.message || String(err.cause)),
    };
    console.error('Error details:', safeStringify(details));
  } catch {}
  process.exit(1);
});
