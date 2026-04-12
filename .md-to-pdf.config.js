const path = require('path');

const CHROME_PATHS = {
  darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  win32:  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  linux:  '/usr/bin/google-chrome',
};

const executablePath = process.env.CHROME_PATH || CHROME_PATHS[process.platform];

module.exports = {
  stylesheet: [path.resolve(__dirname, 'book-style.css')],
  body_class: 'book',
  highlight_style: 'atom-one-dark',
  launch_options: {
    executablePath,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  },
  pdf_options: {
    format: 'Letter',
    margin: {
      top: '0.85in',
      right: '0.85in',
      bottom: '0.9in',
      left: '0.9in',
    },
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: `<div style="font-size:7pt; font-family:'Inter',sans-serif; color:#bbb; width:100%; text-align:center; padding-top:0.35in; letter-spacing:1px;">CLAUDE CODE FROM SOURCE</div>`,
    footerTemplate: `<div style="font-size:7pt; font-family:'Inter',sans-serif; color:#aaa; width:100%; text-align:center; padding-bottom:0.35in;"><span class="pageNumber"></span></div>`,
  },
};
