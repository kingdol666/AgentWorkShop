const fs = require('fs');
const s = fs.readFileSync(process.argv[2], 'latin1');
const pages = s.split('\f').filter(x => x.trim().length);
console.log('pages:', pages.length);
const refs = [
  'multi-modal architecture for automated control',
  'Skill-Based Smart Manufacturing',
  'dynamic resource capability exploration',
  'Intelligent Shopfloors',
  'Robot Operated Serial Production Line',
  'Agents4PLC',
  'InstructMPC',
  'state-of-the-art survey',
  'safety-aware process monitoring',
  'modelcontextprotocol',
  'a2a-protocol',
  'batch control--part 1',
  'Enterprise-control system integration',
  'Run-to-Run Control',
  'GuardAgent',
  'Defeating prompt injections',
  'AgentSpec',
  '62443-3-3',
  'Safe reinforcement learning via shielding',
  'Control barrier function',
  'Using simplicity to control complexity',
  'Data reconciliation',
  'Ansi/ISA-18.2',
  'EEMUA 191',
  'Ironies of automation',
  'AgentBench',
  'Not what you',
  'Formalizing and benchmarking prompt injection',
  '23247',
  '800-82',
  '61511',
];
let ok = 0; const miss = [];
refs.forEach((r, i) => {
  if (s.toLowerCase().includes(r.toLowerCase())) ok++; else miss.push('[' + (i + 1) + '] ' + r);
});
console.log('refs present:', ok + '/' + refs.length);
if (miss.length) console.log('MISSING:\n' + miss.join('\n'));
