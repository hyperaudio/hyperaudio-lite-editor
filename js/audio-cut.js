/**
 * Asynchronously cuts sections from an audio file.
 * 
 * Version 0.1.2
 *
 * @param {ArrayBuffer} audioData - The ArrayBuffer of the audio file.
 * @param {number} startTime - The start time in seconds for the cut.
 * @param {number} endTime - The end time in seconds for the cut.
 * @returns {Promise<AudioBuffer>} A Promise that resolves to the cut AudioBuffer.
 *
 * @example
 * // Assuming you have an ArrayBuffer of audio data
 * cutAudioFileAsync(audioData, 10, 20)
 *   .then(cutBuffer => {
 *     // Do something with the cut audio buffer
 *   })
 *   .catch(error => {to_wav
 *     console.error('Error cutting audio file:', error);
 *   });
 *
 * @description
 * This function takes an ArrayBuffer of an audio file and cuts a portion of it from startTime to endTime.
 * It returns a Promise that resolves to an AudioBuffer of the cut section.
 * The function utilizes the Web Audio API for decoding and manipulating the audio data.
 */
export async function cutAudioFileAsync(audioData, startTime, endTime) {
  const audioContext = new (window.AudioContext || window.webkitAudioContext)();

  // Decode the audio asynchronously
  function decodeAudioDataAsync(audioContext, audioData) {
    return new Promise((resolve, reject) => {
      audioContext.decodeAudioData(audioData, resolve, reject);
    });
  }

  try {
    const decodedData = await decodeAudioDataAsync(audioContext, audioData);
    const sampleRate = decodedData.sampleRate;
    const startOffset = startTime * sampleRate;
    const endOffset = endTime * sampleRate;

    // Create a new buffer for the desired part of the audio
    const cutBuffer = audioContext.createBuffer(
      decodedData.numberOfChannels,
      endOffset - startOffset,
      sampleRate
    );

    // Copy the data into the new buffer
    for (let channel = 0; channel < decodedData.numberOfChannels; channel++) {
      const channelData = decodedData.getChannelData(channel);
      cutBuffer.copyToChannel(
        channelData.subarray(startOffset, endOffset),
        channel
      );
    }

    return cutBuffer;
  } catch (e) {
    console.error("Error with decoding audio data", e);
    throw e;
  }
}

export async function convertAudioBufferToWavBlob(audioBuffer) {
  audioBuffer = convertMultiChannelToMono(audioBuffer);

  const numberOfChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const format = 1; // PCM
  const bitDepth = 16;

  let bufferLength = 44; // Length of the WAV header
  for (let i = 0; i < numberOfChannels; i++) {
    bufferLength += audioBuffer.getChannelData(i).length * 2; // 2 bytes per sample
  }

  const buffer = new ArrayBuffer(bufferLength);
  const view = new DataView(buffer);

  // Scrivi l'header WAV
  writeString(view, 0, "RIFF"); // ChunkID
  view.setUint32(4, 36 + bufferLength - 44, true); // ChunkSize
  writeString(view, 8, "WAVE"); // Format
  writeString(view, 12, "fmt "); // Subchunk1ID
  view.setUint32(16, 16, true); // Subchunk1Size
  view.setUint16(20, format, true); // AudioFormat
  view.setUint16(22, numberOfChannels, true); // NumChannels
  view.setUint32(24, sampleRate, true); // SampleRate
  view.setUint32(28, sampleRate * numberOfChannels * 2, true); // ByteRate
  view.setUint16(32, numberOfChannels * 2, true); // BlockAlign
  view.setUint16(34, bitDepth, true); // BitsPerSample
  writeString(view, 36, "data"); // Subchunk2ID
  view.setUint32(40, bufferLength - 44, true); // Subchunk2Size

  // Write the audio samples
  let offset = 44;
  for (let channel = 0; channel < numberOfChannels; channel++) {
    const channelData = audioBuffer.getChannelData(channel);
    for (let i = 0; i < channelData.length; i++, offset += 2) {
      const sample = Math.max(-1, Math.min(1, channelData[i]));
      view.setInt16(
        offset,
        sample < 0 ? sample * 0x8000 : sample * 0x7fff,
        true
      );
    }
  }

  return new Blob([view], { type: "audio/wav" });
}

function writeString(view, offset, string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

function convertMultiChannelToMono(audioBuffer) {
  const numberOfChannels = audioBuffer.numberOfChannels;

  // Crea un nuovo AudioBuffer mono
  const monoBuffer = new AudioBuffer({
    length: audioBuffer.length,
    sampleRate: audioBuffer.sampleRate,
    numberOfChannels: 1,
  });

  const monoChannel = monoBuffer.getChannelData(0);

  // Mixdown dei canali
  for (let i = 0; i < audioBuffer.length; i++) {
    let sum = 0;
    for (let channel = 0; channel < numberOfChannels; channel++) {
      sum += audioBuffer.getChannelData(channel)[i];
    }
    monoChannel[i] = sum / numberOfChannels;
  }

  return monoBuffer;
}

/**
 * Represents audio data including its URL, start and stop times, and an AudioBuffer.
 *
 * @example
 * // Example usage:
 * let myAudioData = new AudioData('http://example.com/audio.wav', 0, 10);
 * // Later on, you can set the AudioBuffer
 * myAudioData.setAudioBuffer(loadedAudioBuffer);
 */
export class AudioData {
  /**
   * Constructs an instance of AudioData.
   * @param {string} url - The URL of the audio file.
   * @param {number} start - The start time of the audio segment in seconds.
   * @param {number} stop - The stop time of the audio segment in seconds.
   */
  static audioBuffers = [];

  constructor(url, start, stop) {
    this.url = url; // URL of the audio file
    this.start = start; // Start time of the audio segment (in seconds)
    this.stop = stop; // Stop time of the audio segment (in seconds)
    this.audioBuffer = null; // AudioBuffer, initially set to null
  }

  static clearAudioBuffers() {
    AudioData.audioBuffers = [];
  }

  /**
   * Sets the AudioBuffer for this audio data.
   * @param {AudioBuffer} audioBuffer - The AudioBuffer to be associated with this audio data.
   */
  setAudioBuffer(audioBuffer) {
    this.audioBuffer = audioBuffer;
    AudioData.audioBuffers.push(audioBuffer);
  }

  static getAllAudioBuffers() {
    return AudioData.audioBuffers;
  }

  // Add any other methods that might be useful for this class
}
export function concatenateAudioBuffers(audioBuffers) {
  // Assicurati che ci siano AudioBuffer da concatenare
  try {
    if (audioBuffers.length === 0) {
      throw new Error("No audio buffers to concatenate");
    }
  } catch (error) {
    console.log(error);
  }

 
  // Calculate the total length of the buffer
  const totalLength = audioBuffers.reduce(
    (sum, buffer) => sum + buffer.length,
    0
  );

  // Create a ew AuidoBuffer to contain the concatenated data
  const sampleRate = audioBuffers[0].sampleRate; // Assume all buffers have the same sample frequency
  const concatenatedBuffer = new AudioContext().createBuffer(
    audioBuffers[0].numberOfChannels,
    totalLength,
    sampleRate
  );

  // Copy the data into one buffer
  let offset = 0;
  audioBuffers.forEach((buffer) => {
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      concatenatedBuffer
        .getChannelData(channel)
        .set(buffer.getChannelData(channel), offset);
    }
    offset += buffer.length;
  });

  return concatenatedBuffer;
}

// export function fetchAudioBuffer(audioDataArray) {
//   // Usa map per creare un array di promesse
//   const promises = audioDataArray.map(async (audiodata) => {
//     const response = await fetch(audiodata.url);
//     console.log("file download");
//     const arrayBuffer = await response.arrayBuffer();
//     console.log("file buffer");
//     console.log(arrayBuffer);
//     const cutBuffer = await cutAudioFileAsync(
//       arrayBuffer,
//       audiodata.start,
//       audiodata.stop
//     );
//     console.log("file cut");
//     console.log(cutBuffer);
//     audiodata.setAudioBuffer(cutBuffer);
//   });

//   // Restituisce una promessa che si risolve quando tutte le promesse nell'array sono risolte
//   return Promise.all(promises);
// }

export async function fetchAudioBuffer(audioDataArray) {
  // Arrays to keep track of processed audio buffers
  let processedAudioBuffers = [];

  for (const audiodata of audioDataArray) {
    try {
      // Download data as ArrayBuffer
      const response = await fetch(audiodata.url);
      const arrayBuffer = await response.arrayBuffer();

      // Trims the audio buffer based on the specified start and end times
      const cutBuffer = await cutAudioFileAsync(
        arrayBuffer,
        audiodata.start,
        audiodata.stop
      );

      // Sets the trimmed audio buffer for the current AudioData object
      audiodata.setAudioBuffer(cutBuffer);

      // Add the trimmed audio buffer to the processed buffer array
      processedAudioBuffers.push(cutBuffer);
    } catch (error) {
      alert("File must exist, be referenced locally or CORS enabled on the server.");
      break;
    }
  }

  // Returns the array of processed audio buffers, maintaining order
  return processedAudioBuffers;
}

async function testData(url) {
  try {
      const response = await fetch(url);
      if (!response.ok) {
          throw new Error(`HTTP error, status = ${response.status}`);
      }
      return await response.json();
  } catch (error) {
      console.error("Error fetching data:", error);
      if (error.name === "TypeError" && error.message.includes("fetch")) {
          console.error("This error may be related to CORS.");
      }
      // Handle error appropriately
      return null;
  }
}

export function printAudioBuffersDetails() {
  const allAudioBuffers = AudioData.getAllAudioBuffers();
  allAudioBuffers.forEach((audioBuffer, index) => {
    // console.dir(audioBuffer);
    // console.log(`AudioBuffer ${index}:`);
    // Here you can access specific properties of the AudioBuffer
    // For example, length, duration, sampleRate, etc.
    // console.log(`  Length: ${audioBuffer.length}`);
    // console.log(`  Duration: ${audioBuffer.duration}`);
    // console.log(`  Sample Rate: ${audioBuffer.sampleRate}`);
    // Aggiungi altre proprietà che desideri visualizzare
  });
}

export async function cutAudio(audioDataArray) {
  await fetchAudioBuffer(audioDataArray);
  console.log(audioDataArray);
  console.log(`allAudioBuffer ${AudioData.getAllAudioBuffers()} --- `);
  printAudioBuffersDetails();

  const cutBuffer = concatenateAudioBuffers(AudioData.getAllAudioBuffers());
  const wavBlob = await convertAudioBufferToWavBlob(cutBuffer);
  AudioData.clearAudioBuffers();
  return wavBlob;
}

export function to_wav(wavBlob, download_name) {
  const url = URL.createObjectURL(wavBlob);

  // Create <a> to allow download
  const a = document.createElement("a");
  a.href = url;
  a.download = `${download_name}.wav`; // Note the file will be WAV not mp3
  document.body.appendChild(a);
  a.click();

  // Clean up
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function playAudio(wavBlob, audioElementId) {
  const url = URL.createObjectURL(wavBlob);
  const audioElement = document.getElementById(audioElementId);
  audioElement.src = url;
}

export const cutAudioApp = {
  cutAudio: cutAudio,
  to_wav: to_wav,
  playAudio: playAudio,
};
