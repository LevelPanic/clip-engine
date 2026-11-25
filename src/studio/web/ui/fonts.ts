// The Studio's interface fonts (tokens.css: --font-ui, --font-mono), through the same Google Fonts loader the
// caption fonts use, so no new dependency. Without a connection the system fonts in the stacks take over.
import { loadFont as instrumentSans } from '@remotion/google-fonts/InstrumentSans';
import { loadFont as jetbrainsMono } from '@remotion/google-fonts/JetBrainsMono';

instrumentSans('normal', { weights: ['400', '500', '600', '700'], subsets: ['latin'] });
jetbrainsMono('normal', { weights: ['400', '500'], subsets: ['latin'] });
