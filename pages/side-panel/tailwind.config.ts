import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  // No `important: true` — side panel is NOT in Shadow DOM, no need to override host page styles
  corePlugins: {
    preflight: true,
  },
  theme: {
    extend: {},
  },
} satisfies Config;
