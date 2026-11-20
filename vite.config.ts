import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({base:'/whats-interesting-telegram/',plugins:[react()],build:{sourcemap:false}});
