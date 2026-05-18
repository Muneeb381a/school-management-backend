'use strict';

const crypto = require('crypto');
const axios  = require('axios');

// ── JazzCash ──────────────────────────────────────────────────────────────────
const JC = {
  merchantId:     process.env.JAZZCASH_MERCHANT_ID     || '',
  password:       process.env.JAZZCASH_PASSWORD        || '',
  integritySalt:  process.env.JAZZCASH_INTEGRITY_SALT  || '',
  sandbox:        process.env.NODE_ENV !== 'production',
};

function jcBaseUrl() {
  return JC.sandbox
    ? 'https://sandbox.jazzcash.com.pk/ApplicationAPI/API/2.0/Purchase'
    : 'https://payments.jazzcash.com.pk/ApplicationAPI/API/2.0/Purchase';
}

// JazzCash HMAC-SHA256: sort pp_ params alpha, concat values with &, prepend salt
function jcSecureHash(params) {
  const sorted = Object.keys(params)
    .filter(k => k.startsWith('pp_') && params[k] !== '')
    .sort()
    .map(k => params[k]);
  const str = JC.integritySalt + '&' + sorted.join('&');
  return crypto.createHmac('sha256', JC.integritySalt).update(str).digest('hex').toUpperCase();
}

function jcDateTime(date = new Date()) {
  return date.toISOString().replace(/[-T:.Z]/g, '').slice(0, 14);
}

function jcTxnRef() {
  return 'T' + jcDateTime() + Math.random().toString(36).slice(2, 6).toUpperCase();
}

// Initiate JazzCash MWALLET (mobile wallet) payment
async function initiateJazzCash({ invoiceNo, amountPKR, phone, description }) {
  const txnRef   = jcTxnRef();
  const now      = new Date();
  const expiry   = new Date(now.getTime() + 60 * 60 * 1000); // +1 hour

  // Normalize Pakistani phone: 03xx... → 923xx...
  const msisdn = phone.replace(/^0/, '92').replace(/[^0-9]/g, '');

  const params = {
    pp_Version:             '2.0',
    pp_TxnType:             'MWALLET',
    pp_Language:            'EN',
    pp_MerchantID:          JC.merchantId,
    pp_SubMerchantID:       '',
    pp_Password:            JC.password,
    pp_BankID:              'TBANK',
    pp_ProductID:           'RETL',
    pp_TxnRefNo:            txnRef,
    pp_Amount:              String(Math.round(amountPKR * 100)), // paisa
    pp_TxnCurrency:         'PKR',
    pp_TxnDateTime:         jcDateTime(now),
    pp_BillReference:       invoiceNo,
    pp_Description:         description.slice(0, 100),
    pp_TxnExpiryDateTime:   jcDateTime(expiry),
    pp_MSISDN:              msisdn,
    pp_MobileNumber:        msisdn,
  };

  params.pp_SecureHash = jcSecureHash(params);

  const { data } = await axios.post(`${jcBaseUrl()}/DoMWalletTransaction`, params, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 15_000,
  });

  return { txnRef, raw: data, responseCode: data.pp_ResponseCode, responseDesc: data.pp_ResponseMessage };
}

// Verify JazzCash callback secure hash
function verifyJazzCashCallback(params) {
  const received = params.pp_SecureHash;
  const expected = jcSecureHash(params);
  return received === expected;
}

// ── EasyPaisa ─────────────────────────────────────────────────────────────────
const EP = {
  storeId:   process.env.EASYPAISA_STORE_ID   || '',
  hashKey:   process.env.EASYPAISA_HASH_KEY   || '',
  sandbox:   process.env.NODE_ENV !== 'production',
};

function epBaseUrl() {
  return EP.sandbox
    ? 'https://easypaisa.com.pk/tpg'
    : 'https://easypaisa.com.pk/tpg';
}

function epOrderRef() {
  return 'EP' + Date.now() + Math.random().toString(36).slice(2, 5).toUpperCase();
}

// EasyPaisa HMAC-SHA256: sort params alpha, join key=value with &, then HMAC
function epHash(params) {
  const str = Object.keys(params).sort()
    .map(k => `${k}=${params[k]}`)
    .join('&');
  return crypto.createHmac('sha256', EP.hashKey).update(str).digest('hex');
}

// Initiate EasyPaisa Mobile Account payment
async function initiateEasyPaisa({ invoiceNo, amountPKR, phone, description }) {
  const orderRef = epOrderRef();
  const msisdn   = phone.replace(/^0/, '92').replace(/[^0-9]/g, '');

  const params = {
    storeId:          EP.storeId,
    amount:           amountPKR.toFixed(2),
    postBackURL:      `${process.env.BACKEND_URL || ''}/api/online-payments/easypaisa/callback`,
    orderRefNum:      orderRef,
    mobileNum:        msisdn,
    emailAddr:        '',
    merchantPaymentMethod: 'MA',  // Mobile Account
    desc:             description.slice(0, 100),
    currencyCode:     'PKR',
  };

  params.signature = epHash(params);

  const { data } = await axios.post(`${epBaseUrl()}/?action=initiateMobileAccountTransaction`, params, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 15_000,
  });

  return { txnRef: orderRef, raw: data, responseCode: data.responseCode, responseDesc: data.responseDesc };
}

// Verify EasyPaisa callback
function verifyEasyPaisaCallback(params) {
  const received = params.signature;
  const { signature: _, ...rest } = params;
  return received === epHash(rest);
}

// ── Shared status normalizer ──────────────────────────────────────────────────
// JazzCash success code = '000', EasyPaisa success = '0000'
function isSuccess(gateway, responseCode) {
  if (gateway === 'jazzcash')  return responseCode === '000';
  if (gateway === 'easypaisa') return responseCode === '0000';
  return false;
}

module.exports = {
  initiateJazzCash,
  verifyJazzCashCallback,
  initiateEasyPaisa,
  verifyEasyPaisaCallback,
  isSuccess,
};
