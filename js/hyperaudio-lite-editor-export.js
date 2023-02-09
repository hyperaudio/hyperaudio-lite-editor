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
    downloadJson(jsonData)
  }

connectedCallback() {
    this.innerHTML =  `<button onclick="${this.exportJson}">export json ⬆</button>`;
    this.addEventListener('click', this.exportJson)
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
            const jsonData = JSON.parse(event.target.result);
            console.log
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
    this.innerHTML =  `<button onclick="${this.importJson}">import json ⬇</button>`;
    this.addEventListener('click', this.importJson)
  }
}

customElements.define('import-json', ImportJson);




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


