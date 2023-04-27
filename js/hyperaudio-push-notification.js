Notification.requestPermission().then(perm => {
    console.log('permission: ', perm)
})


const notifyTrasciptionReady = () => {
    let notification = new Notification("Transcription is ready", {
        body: "Click here to see the transcription"
    })

    notification.onclick = () => {
    window.parent.parent.focus();
    }

}

window.document.addEventListener('hyperaudioInit', notifyTrasciptionReady, false);