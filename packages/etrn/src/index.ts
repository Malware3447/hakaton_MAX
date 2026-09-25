// Накладная: XML титулов Т1–Т4 по формату ФНС 5.01, проверка по XSD, PDF, обёртки openssl.
// Наполняется в HAKATON-35 (XML) и HAKATON-36 (подписи); проверка подписи «Госключа» — HAKATON-41.

export const ETRN_FORMAT_VERSION = '5.01'

export * from './signature-verify.ts'
export { FilePkiStore, PkiError, type PkiStore, type TrustAnchors } from './pki.ts'
export { gostAvailable } from './openssl.ts'
