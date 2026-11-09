import { Module } from '@nestjs/common';
import { DriftScanner } from './drift-scanner.js';

/** The scanner alone, with no dependency on P1 or P2 services, so both can call it without a module cycle. */
@Module({ providers: [DriftScanner], exports: [DriftScanner] })
export class PortfolioScanModule {}
