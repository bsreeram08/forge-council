#!/usr/bin/env bun
import { initErrorLogging } from './errors/logger.ts';
import { runCLI } from './cli/index.ts';

initErrorLogging();
runCLI();
