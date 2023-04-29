export function isAmazonTranscribeJsonFormat(j) {
  return (
    'jobName' in j && 'accountId' in j && 'results' in j && 'transcripts' in j['results'] && 'items' in j['results']
  );
}

export function convertAmznJsonToHyprJson(j) {
  // ask user for video URL
  var VIDEO_URL = 'file:///Users/foo/Downloads/trimmed.mp4';
  VIDEO_URL = prompt(
    'Enter online video URL (or local file path but only if you are running this web app locally):',
    VIDEO_URL,
  );
  if (VIDEO_URL === null || VIDEO_URL === '') {
    alert('No valid video URL provided, not continuing');
    return;
  }

  const d_hypr = {
    article: { section: { paragraphs: [] } },
    url: VIDEO_URL,
  };

  let current_speaker_label = '';
  var d_span = {};

  for (const dict of j['results']['items']) {
    // in hyperaudio, 1 {"spans": [{word1}, {word2}]} = 1 speaker
    // d_span = {"spans": []}

    // Amazon Transcribe data
    const type = dict['type'];
    const first_alternative = dict['alternatives'][0]['content']; // best guess of the word spoken

    // handle punctuation by appending it to last text
    if (type === 'punctuation') {
      // type is either pronunciation or punctuation (does not have m or d)
      const len = d_span['spans'].length;
      // console.log(len);
      d_span['spans'][len - 1]['text'] = d_span['spans'][len - 1]['text'].trimEnd() + first_alternative + ' ';
      continue;
    }

    // Amazon Transcribe data
    const speaker_label = dict['speaker_label'];
    const start_time = dict['start_time'];
    const end_time = dict['end_time'];

    // parse to hyperaudio-lite data
    // see https://github.com/hyperaudio/hyperaudio-lite#vhs-data-formats-vhs
    const m = Math.floor(parseFloat(start_time) * 1000);
    const d = Math.floor((parseFloat(end_time) - parseFloat(start_time)) * 1000);
    const text = first_alternative + ' ';

    // if new speaker
    if (speaker_label !== current_speaker_label) {
      // append old d_span if not {}
      if (Object.keys(d_span).length !== 0) {
        d_hypr['article']['section']['paragraphs'].push(d_span);
      }

      // create new d_span
      d_span = {
        spans: [
          {
            m: String(m),
            d: '0',
            class: 'speaker read',
            text: '[' + speaker_label + '] ',
          },
        ],
      };
    }

    d_span['spans'].push({ m: String(m), d: String(d), class: 'read', text: text });
    current_speaker_label = speaker_label;
  }

  // console.log(d_hypr);
  return d_hypr;
}
