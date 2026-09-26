/** Small code-native inventory icons. Integer coordinates retain crisp pixel edges. */
const shapes: Record<string, [string, string][]> = {
  compose: [['#e5e5ce', 'M4 19h3v-3h3v-3h3v-3h3V7h3V3h-5v3h-3v3H8v3H5v4H3v3z'], ['#929487', 'M3 20h3v-3h3v-3h3v-3h3V8h2V5h-2v3h-3v3H9v3H6v3H3z']],
  search: [['#93c9dd', 'M5 3h8v2h2v8h-2v2H5v-2H3V5h2z'], ['#997043', 'M14 13h3v3h3v3h2v3h-4v-3h-3v-3h-2z'], ['#dbf4f5', 'M6 5h5v2H8v4H5V7h1z']],
  settings: [['#a4a6a0', 'M9 2h6v3h3V4h3v5h-3v6h3v5h-4v-2h-2v4H9v-4H6v2H2v-5h3V9H2V4h4v2h3z'], ['#343832', 'M9 8h6v2h2v4h-2v2H9v-2H7v-4h2z']],
  kanban: [['#bd9252', 'M2 4h20v14H2z M10 18h4v5h-4z'], ['#5d4328', 'M5 7h3v3H5z M10 7h9v3h-9z M5 12h7v3H5z M14 12h5v3h-5z']],
  cron: [['#dab44e', 'M8 2h8v2h4v4h2v8h-2v4h-4v2H8v-2H4v-4H2V8h2V4h4z'], ['#eeeadd', 'M8 5h8v2h3v10h-3v2H8v-2H5V7h3z'], ['#393c36', 'M11 7h2v6h4v2h-6z']],
  terminal: [['#b5b7ac', 'M2 3h20v18H2z'], ['#282c29', 'M4 5h16v14H4z'], ['#b5de91', 'M6 7h2v2h2v2h2v2h-2v2H8v2H6v-2h2v-2h2v-2H8V9H6z M13 15h5v2h-5z']],
  files: [['#d7a83e', 'M2 5h8v3h12v13H2z'], ['#ffe090', 'M3 6h6v3h12v3H3z'], ['#eac25d', 'M4 12h16v7H4z']],
  skills: [['#6b9d48', 'M9 2h6v5h5v3h3v5h-5v6h-6v-3H8v3H3v-6H1V9h6V5h2z'], ['#a0c775', 'M9 5h3v5H6v5H4v-4h4V8h1z']],
  achievements: [['#c99730', 'M5 3h14v3h4v7h-5v3h-4v4h4v3H6v-3h4v-4H6v-3H1V6h4z'], ['#ffd86b', 'M7 5h10v8h-2v3H9v-3H7z'], ['#fff1b2', 'M8 6h3v6H8z'], ['#3e3525', 'M3 8h2v3H3z M19 8h2v3h-2z']],
  moon: [['#edce72', 'M10 2h6v2h-4v3H9v8h3v3h6v-2h3v4h-5v2H9v-2H5v-4H3V8h2V5h5z']],
  sun: [['#edce72', 'M10 1h4v4h-4z M10 19h4v4h-4z M1 10h4v4H1z M19 10h4v4h-4z M4 4h3v3H4z M17 4h3v3h-3z M4 17h3v3H4z M17 17h3v3h-3z M8 7h8v2h2v6h-2v2H8v-2H6V9h2z']],
};
export function craftingIcon(React: any, name: string) {
  return React.createElement('svg', { viewBox: '0 0 24 24', width: 28, height: 28,
    className: 'crafting-icon', 'aria-hidden': true, shapeRendering: 'crispEdges' },
  ...(shapes[name] || shapes.files).map(([fill, d], index) => React.createElement('path', {
    key: index, d, fill, stroke: index === 0 ? '#36352c' : 'none', strokeWidth: 1,
    strokeLinejoin: 'miter',
  })));
}
