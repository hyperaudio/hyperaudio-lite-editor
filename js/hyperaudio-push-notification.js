/*! (C) The Hyperaudio Project. MIT @license: en.wikipedia.org/wiki/MIT_License. */
/*! Last modified for Version 0.3.1 */

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