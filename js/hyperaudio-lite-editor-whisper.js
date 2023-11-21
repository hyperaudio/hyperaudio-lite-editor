/*! (C) The Hyperaudio Project. MIT @license: en.wikipedia.org/wiki/MIT_License. */
/*! Version 0.0.1 */

class WhisperService extends HTMLElement {

  constructor() {
    super();
  }


  connectedCallback() {

    let template = null;
    let modal = this;

    const templateUrl = "hyperaudio-client-whisper-template.html";

    console.log("whisper wc connected callback");


    if (templateUrl !== null) {
      fetch(templateUrl)
        .then(function(response) {
            // When the page is loaded convert it to text
            return response.text()
        })
        .then(function(html) {
          // Initialize the DOM parser
          let parser = new DOMParser();

          // Parse the text
          template = parser.parseFromString(html, "text/html");
          let whisperTempl = template.querySelector('#whisper-client-template').cloneNode(true);
          modal.innerHTML = whisperTempl.innerHTML;
          loadWhisperClient(modal);
        })
        .catch(function(err) {  
          console.log('Template error: ', err);  
        });
    }
  }
}

customElements.define('client-whisper-service', WhisperService);

function loadWhisperClient(modal) {
  console.log("load whisper client");
  let scriptElement = document.createElement('script');
  scriptElement.src = 'whisper-client-bundle.js';
  scriptElement.id = 'whisperClientScript';
  document.body.appendChild(scriptElement);
  const script = document.querySelector("#whisperClientScript");
  console.log(script);
  (0, eval)(script.textContent);
  //document.querySelector("#form-submit-btn").addEventListener('click',modal.prepareWorker());

}



function addEventListeners(modal) {
  /*document.querySelector('#file').addEventListener('change',modal.clearMediaUrl);
  document.querySelector('#media').addEventListener('change',modal.clearFilePicker);
  document.querySelector('#transcribe-btn').addEventListener('click', modal.getData);
  document.querySelector('#file').addEventListener('change', modal.updatePlayerWithLocalFile);
  document.querySelector('#language-model').addEventListener('change', modal.updateDropdowns);
  document.querySelector('#language-model').addEventListener('change', modal.updateTierDropdown);
  document.querySelector('#language').addEventListener('change', modal.updateTierDropdown);*/


}