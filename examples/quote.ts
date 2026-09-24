// Offline example: no wallet, network access, signature request, or transaction.
import { parseSol, formatSol } from '../src/amounts.js';
import { quoteWithdrawal } from '../src/fees.js';

const quote = quoteWithdrawal(parseSol('0.1'));
console.log({
  grossSol: formatSol(quote.grossLamports),
  feeSol: formatSol(quote.feeLamports),
  recipientSol: formatSol(quote.recipientLamports),
});
