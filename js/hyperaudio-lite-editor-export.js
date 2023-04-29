import {
  isAmazonTranscribeJsonFormat,
  convertAmznJsonToHyprJson,
} from './amazon-transcribe-json-to-hyperaudio-lite-json-converter.js';

class ExportJson extends HTMLElement {

  constructor() {
    super();
  }

  exportJson() {
    let hypertranscript = document.getElementById('hypertranscript');
    console.log(hypertranscript);
    // transform in json object with dom elements
    let jsonData = htmlToJson(hypertranscript);
    jsonData.url = document.querySelector("#hyperplayer").src;
    console.log(jsonData);
    downloadJson(jsonData);
  }

  connectedCallback() {
    //this.innerHTML =  `<button onclick="${this.exportJson}">export json ⬇</button>`;
    this.innerHTML = `<a onclick="${this.exportJson}">Export JSON</a>`;
    this.addEventListener('click', this.exportJson);
  }
}

customElements.define('export-json', ExportJson);

class ImportJson extends HTMLElement {

  constructor() {
    super();
  }

  importJson() {

    //import data from json file when click on import button
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'application/json';
    fileInput.addEventListener('change', (event) => {
      const file = event.target.files[0];
      const reader = new FileReader();
      reader.addEventListener('load', (event) => {
        var jsonData = JSON.parse(event.target.result);

        // check if JSON is Amazon Transcribe format, if so, then
        // convert to hyperaudio-lite format
        if (isAmazonTranscribeJsonFormat(jsonData)) {
          jsonData = convertAmznJsonToHyprJson(jsonData);
          if (typeof jsonData === 'undefined')
            return;
        }

        // transform json object in html
        let hypertranscript = document.getElementById('hypertranscript');

        /* simple innerHTML
        hypertranscript.innerHTML = jsonData.data;
        */
        hypertranscript.innerHTML = jsonToHtml(jsonData);
        // set video url
        document.querySelector("#hyperplayer").src = jsonData.url;
      });
      reader.readAsText(file);
      document.dispatchEvent(new CustomEvent('hyperaudioInit'));
    });
    fileInput.click();
  }

  connectedCallback() {
    //this.innerHTML =  `<button onclick="${this.importJson}">import json ⬆</button>`;
    this.innerHTML = `<a onclick="${this.importJson}">Import JSON</a>`;
    this.addEventListener('click', this.importJson);
  }
}

customElements.define('import-json', ImportJson);


class ImportSrt extends HTMLElement {

  constructor() {
    super();
  }

  importSrt() {
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'application/text';
    fileInput.addEventListener('change', (event) => {
        const file = event.target.files[0];
        const reader = new FileReader();
        reader.addEventListener('load', (event) => {
            const srtData = event.target.result;
            // transform json object in html
            let hypertranscript = document.getElementById('hypertranscript');
            hypertranscript.innerHTML = srtToHtml(srtData);
            document.dispatchEvent(new CustomEvent('hyperaudioInit'));
        });
        reader.readAsText(file);
       
    });
    fileInput.click();
  }

  connectedCallback() {
    //this.innerHTML =  `<button onclick="${this.importSrt}">import srt ⬆</button>`;
    this.innerHTML = `<a onclick="${this.importSrt}">Import SRT</a>`;
    this.addEventListener('click', this.importSrt);
  }
}

customElements.define('import-srt', ImportSrt);


function downloadJson(jsonData) {
  // download json file
  let dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(jsonData));
  //start download
  let downloadAnchorNode = document.createElement('a');
  downloadAnchorNode.setAttribute('href', dataStr);
  downloadAnchorNode.setAttribute('download', 'hyperaudio-lite.json');
  document.body.appendChild(downloadAnchorNode); // required for firefox
  downloadAnchorNode.click();
  downloadAnchorNode.remove();
}

// Convert Hypertranscript to JSON
function htmlToJson(html) {
  const article = html.querySelector('article');

  // Create an empty object to store the JSON data
  const jsonData = {};

  // Add the <article> element data to the JSON object
  jsonData.article = {};

  // Get the <section> element
  const section = article.querySelector('section');

  // Add the <section> element data to the JSON object
  jsonData.article.section = {};

  // Get the <p> element
  const paragraphs = section.querySelectorAll('p');

  // Add the <p> element data to the JSON object
  jsonData.article.section.paragraphs = [];

  // Iterate through each <p> element
  for (const paragraph of paragraphs) {
    // Create an object to store the <p> element data
    const paragraphData = {};
    // Get all the <span> elements within the <p> element
    const spans = paragraph.querySelectorAll('span');

    // Add the <span> elements data to the JSON object
    paragraphData.spans = [];

    // Iterate through each <span> element
    for (const span of spans) {
      // Create an object to store the <span> element data
      const spanData = {};

      // Get the "data-m" attribute value
      spanData.m = span.getAttribute('data-m');

      // Get the "data-d" attribute value
      spanData.d = span.getAttribute('data-d');

      // Get the class attribute value
      spanData.class = span.getAttribute('class');

      // Get the text content of the <span> element
      spanData.text = span.textContent;

      // Add the <span> element data to the JSON object
      paragraphData.spans.push(spanData);
    }
    jsonData.article.section.paragraphs.push(paragraphData);
  }
  // Return the JSON object
  return jsonData;
}


// Convert JSON to Hypertranscript HTML
function jsonToHtml(jsonData) {
  // Create an empty <article> element
  const div = document.createElement('div');

  const article = document.createElement('article');

  // Create an empty <section> element
  const section = document.createElement('section');

  // Add the <section> element to the <article> element
  article.appendChild(section);

  // Get the <p> elements data from the JSON object
  const paragraphs = jsonData.article.section.paragraphs;

  // Iterate through each <p> element
  for (const paragraph of paragraphs) {
    // Create an empty <p> element
    const p = document.createElement('p');

    // Add the <p> element to the <section> element
    section.appendChild(p);

    // Get the <span> elements data from the JSON object
    const spans = paragraph.spans;

    // Iterate through each <span> element
    for (const span of spans) {
      // Create an empty <span> element
      const spanElement = document.createElement('span');

      // Set the "data-m" attribute value
      spanElement.setAttribute('data-m', span.m);

      // Set the "data-d" attribute value
      spanElement.setAttribute('data-d', span.d);

      // Set the class attribute value
      spanElement.setAttribute('class', span.class);

      // Set the text content of the <span> element
      spanElement.textContent = span.text;

      // Add the <span> element to the <p> element
      p.appendChild(spanElement);
    }
  }

  div.appendChild(article);
  // Return the <article> element

  return div.innerHTML;
}

function srtToHtml(data) {
  let i = 0,
  len = 0,
  idx = 0,
  lines,
  time,
  text,
  sub;

  // Simple function to convert HH:MM:SS,MMM or HH:MM:SS.MMM to SS.MMM
  // Assume valid, returns 0 on error

  let toSeconds = function(t_in) {
    let t = t_in.split(':');

    try {
      let s = t[2].split(',');

      // Just in case a . is decimal seperator
      if (s.length === 1) {
        s = t[2].split('.');
      }

      return (
        parseFloat(t[0], 10) * 3600 +
        parseFloat(t[1], 10) * 60 +
        parseFloat(s[0], 10) +
        parseFloat(s[1], 10) / 1000
      );
    } catch (e) {
      return 0;
    }
  };

  let paraSplitTime = 1.5;
  let paraPunct = true;
  let outputString = '<article><section><p>';
  let lineBreaks = false;
  let ltime = 0;
  let ltext;

  // Here is where the magic happens
  // Split on line breaks
  lines = data.split(/(?:\r\n|\r|\n)/gm);
  len = lines.length;

  for (i = 0; i < len; i++) {
    sub = {};
    text = [];

    sub.id = parseInt(lines[i++], 10);

    // Split on '-->' delimiter, trimming spaces as well

    try {
      time = lines[i++].split(/[\t ]*-->[\t ]*/);
    } catch (e) {
      console.log('Warning. Possible issue on line ' + i + ": '" + lines[i] + "'.");
      break;
    }

    sub.start = toSeconds(time[0]);

    // So as to trim positioning information from end
    if (!time[1]) {
      alert('Warning. Issue on line ' + i + ": '" + lines[i] + "'.");
      return;
    }

    idx = time[1].indexOf(' ');
    if (idx !== -1) {
      time[1] = time[1].substr(0, idx);
    }
    sub.end = toSeconds(time[1]);

    // Build single line of text from multi-line subtitle in file
    while (i < len && lines[i]) {
      text.push(lines[i++]);
    }

    // Join into 1 line, SSA-style linebreaks
    // Strip out other SSA-style tags
    sub.text = text.join('\\N').replace(/\{(\\[\w]+\(?([\w\d]+,?)+\)?)+\}/gi, '');

    // Escape HTML entities
    sub.text = sub.text.replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // Unescape great than and less than when it makes a valid html tag of a supported style (font, b, u, s, i)
    // Modified version of regex from Phil Haack's blog: http://haacked.com/archive/2004/10/25/usingregularexpressionstomatchhtml.aspx
    // Later modified by kev: http://kevin.deldycke.com/2007/03/ultimate-regular-expression-for-html-tag-parsing-with-php/
    sub.text = sub.text.replace(
      /&lt;(\/?(font|b|u|i|s))((\s+(\w|\w[\w\-]*\w)(\s*=\s*(?:\".*?\"|'.*?'|[^'\">\s]+))?)+\s*|\s*)(\/?)&gt;/gi,
      '<$1$3$7>'
    );
    //sub.text = sub.text.replace( /\\N/gi, "<br />" );
    sub.text = sub.text.replace(/\\N/gi, ' ');

    let splitMode = 0;

    let wordLengthSplit = true; //$('#word-length').prop('checked');

    // enhancements to take account of word length

    let swords = sub.text.split(' ');
    let sduration = sub.end - sub.start;
    let stimeStep = sduration / swords.length;

    // determine length of words

    let swordLengths = [];

    let totalLetters = 0;
    for (let si = 0, sl = swords.length; si < sl; ++si) {
      totalLetters = totalLetters + swords[si].length;
      swordLengths[si] = swords[si].length;
    }

    let letterTime = sduration / totalLetters;
    let wordStart = 0;

    for (let si = 0, sl = swords.length; si < sl; ++si) {
      let wordTime = swordLengths[si] * letterTime;
      let stime;
      if (wordLengthSplit) {
        stime = Math.round((sub.start + si * stimeStep) * 1000);
      } else {
        stime = Math.round((wordStart + sub.start) * 1000);
      }

      wordStart = wordStart + wordTime;
      let stext = swords[si];

      if (stime - ltime > paraSplitTime * 1000 && paraSplitTime > 0) {

        let punctPresent =
          ltext && (ltext.indexOf('.') > 0 || ltext.indexOf('?') > 0 || ltext.indexOf('!') > 0);
        if (!paraPunct || (paraPunct && punctPresent)) {
          outputString += '</p><p>';
        }
      }

      outputString += '<span data-m="' + stime + '">' + stext + ' </span>';

      ltime = stime;
      ltext = stext;

      if (lineBreaks) outputString = outputString + '\n';
    }
  }
  return outputString + '</p></section></article>';
}



