export function addTiming() {
  // Ensure the style is added only once
  if (!document.getElementById('timing-style')) {
    const style = document.createElement('style');
    style.id = 'timing-style';
    document.head.appendChild(style);
    style.sheet.insertRule('article { display: flex; flex-direction: column; }', 0);
    style.sheet.insertRule('.paragraph-container { display: flex; align-items: flex-start; gap: 10px; }', 1);
    style.sheet.insertRule(
      '.timing-info { width: 150px; padding: 5px; background-color: #f0f0f0; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }',
      2,
    );
    style.sheet.insertRule('p { flex: 1; margin: 0; }', 3); // Ensure paragraphs take all remaining space
  }

  const article = document.querySelector('article');
  if (!article) {
    console.error('Article element not found');
    return;
  }

  const sections = article.getElementsByTagName('section');
  let lastKnownSpeaker = ''; // Variable to hold the last known speaker

  Array.from(sections).forEach(section => {
    const paragraphs = section.getElementsByTagName('p');

    Array.from(paragraphs).forEach(paragraph => {
      // Remove old timing info if present
      if (paragraph.parentNode.classList.contains('paragraph-container')) {
        paragraph.parentNode.querySelector('.timing-info').remove();
      } else {
        // Create paragraph container if not already existing
        const newParagraphContainer = document.createElement('div');
        newParagraphContainer.className = 'paragraph-container';
        section.replaceChild(newParagraphContainer, paragraph);
        newParagraphContainer.appendChild(paragraph);
      }

      const spans = paragraph.querySelectorAll('span[data-m][data-d]');
      let minStartTime = Infinity;
      let totalDuration = 0;
      let speaker = '';

      // Look for speaker information
      const speakerSpan = paragraph.querySelector('span.speaker');
      if (speakerSpan) {
        speaker = speakerSpan.textContent.trim();
        lastKnownSpeaker = speaker; // Update last known speaker
      } else {
        speaker = lastKnownSpeaker; // Use the last known speaker if no new speaker is found
      }

      spans.forEach(span => {
        const startTime = parseInt(span.getAttribute('data-m'), 10);
        const duration = parseInt(span.getAttribute('data-d'), 10);
        if (startTime < minStartTime) minStartTime = startTime;
        totalDuration += duration;
      });

      const endTime = minStartTime + totalDuration;

      // Create new timing div
      const timingDiv = document.createElement('div');
      timingDiv.className = 'timing-info';
      timingDiv.textContent = `Speaker: ${speaker}, Start: ${formatTime(minStartTime)}`;
      paragraph.parentNode.insertBefore(timingDiv, paragraph);
    });
  });
}

function formatTime(milliseconds) {
  let seconds = Math.floor(milliseconds / 1000);
  let minutes = Math.floor(seconds / 60);
  let hours = Math.floor(minutes / 60);
  seconds = seconds % 60;
  minutes = minutes % 60;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

function pad(number) {
  return number < 10 ? '0' + number : number;
}

/* code to add to index.html
  <script type="module">
    import { addTiming } from './js/hyperaudio-lite-editor-visualize-timing.js';

    // Ascoltatore per garantire che il DOM sia completamente caricato
    document.addEventListener('DOMContentLoaded', () => {
        addTiming();
    });
</script>
*/
