/*! (C) The Hyperaudio Project. MIT @license: en.wikipedia.org/wiki/MIT_License. */
/*! Last modified for Version 1.3.34 */

Notification.requestPermission().then(perm => {
    console.log('permission: ', perm)
})

const notifyTranscriptionReady = () => {
    let notification = new Notification("Your Hyperaudio transcript is ready!", {
        body: "Click here to see your transcript."
    })

    notification.onclick = () => {
    window.parent.parent.focus();
    }

}

window.document.addEventListener('hyperaudioInit', notifyTranscriptionReady, false);
// a transcription that finished while another project was open (#715)
window.document.addEventListener('hyperaudioTranscriptionKept', notifyTranscriptionReady, false);