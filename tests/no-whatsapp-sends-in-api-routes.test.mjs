import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();

async function fileText(relPath) {
  const abs = path.join(root, relPath);
  return await readFile(abs, 'utf8');
}

test('VAS execute routes must not send WhatsApp messages directly', async () => {
  const airtime = await fileText('pages/api/vas/airtime/execute.js');
  const data = await fileText('pages/api/vas/data/execute.js');
  const electricity = await fileText('pages/api/vas/electricity/execute.js');

  for (const [name, text] of [
    ['airtime', airtime],
    ['data', data],
    ['electricity', electricity],
  ]) {
    assert.ok(!text.includes('@wapay/whatsapp'), `${name}: should not import @wapay/whatsapp`);
    assert.ok(!text.includes('sendWhatsAppText'), `${name}: should not call sendWhatsAppText`);
    assert.ok(!text.includes('sendWhatsAppTemplate'), `${name}: should not call sendWhatsAppTemplate`);
    assert.ok(!text.includes('sendErrorMessage'), `${name}: should not define/call sendErrorMessage`);
  }
});


