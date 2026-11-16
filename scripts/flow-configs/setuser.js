// Prefix a cfg ("const CFG = {...};"). Rewrites the User settings JSON with CFG.settings + loggingLevel Error.
const body = JSON.stringify({ 'vscwclang.loggingLevel': 'Error', ...(CFG.settings || {}) }, null, 1);
await p.keyboard.press('Escape');
await sleep(300);
await p.keyboard.press('F1');
await sleep(600);
await p.keyboard.type('Preferences: Open User Settings (JSON)');
await sleep(1200);
await p.keyboard.press('Enter');
await sleep(2500);
await p.locator('.monaco-modal-editor-block .view-lines').first().click();
await p.keyboard.press('Control+a');
await p.keyboard.insertText(body);
await sleep(500);
await p.keyboard.press('Control+s');
await sleep(1500);
await p.keyboard.press('Escape');
await sleep(500);
return 'user settings set: ' + body.length + ' bytes';
