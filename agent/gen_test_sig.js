const nacl = require('tweetnacl');
const bs58 = require('bs58');
const { TextEncoder } = require('util');

const keypair = nacl.sign.keyPair();
const publicKey = bs58.default.encode(keypair.publicKey);
const messageStr = "Login Test";
const message = new TextEncoder().encode(messageStr);
const signature = nacl.sign.detached(message, keypair.secretKey);
const signatureHex = Buffer.from(signature).toString('hex');

console.log(JSON.stringify({ publicKey, messageStr, signatureHex }));
