/**
 * CLI standalone para rodar evals fora do servidor HTTP.
 *
 * Uso:
 *   npm run evals                          # roda TODOS os datasets
 *   npm run evals -- --agent "Daniel Souza" # roda só um agent
 *
 * Exit code:
 *   0  → score médio >= 80%
 *   1  → score médio < 80%, ou erro de boot/execução
 *
 * O relatório markdown é gravado em /tmp/evals-report-*.md (um por dataset)
 * e o resumo de cada agent é impresso em stdout pra ser capturado pelo CI.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from '../../../app.module';
import { EvalRunnerService } from './runner.service';
import { EvalReporterService } from './reporter.service';
import { datasets } from './datasets';
import type { EvalRunReport } from './types';

const PASS_THRESHOLD = 80;

interface CliArgs {
  agentName?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--agent' || a === '-a') {
      args.agentName = argv[i + 1];
      i++;
    }
  }
  return args;
}

async function main(): Promise<number> {
  const logger = new Logger('EvalsCLI');
  const cli = parseArgs(process.argv.slice(2));

  // Boot Nest in standalone mode (no HTTP, no socket.io). Disable Nest's
  // verbose logger except for warn/error so the CLI output stays readable.
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['warn', 'error', 'log'],
    abortOnError: false,
  });

  try {
    const runner = app.get(EvalRunnerService);
    const reporter = app.get(EvalReporterService);

    const targets = cli.agentName
      ? [cli.agentName]
      : Object.keys(datasets);

    if (cli.agentName && !datasets[cli.agentName]) {
      logger.error(
        `Dataset for agent "${cli.agentName}" not found. Available: [${Object.keys(datasets).join(', ')}]`,
      );
      return 1;
    }

    const reports: EvalRunReport[] = [];

    for (const agentName of targets) {
      const dataset = datasets[agentName];
      if (!dataset) {
        logger.warn(`Skipping unknown dataset: ${agentName}`);
        continue;
      }

      logger.log(
        `Running ${dataset.cases.length} cases against agent "${agentName}"...`,
      );

      const report = await runner.runDataset(dataset);
      const reportPath = await reporter.writeMarkdown(report);
      reports.push(report);

      logger.log(
        `Done "${agentName}" — score=${report.scorePercent}% (${report.passed}/${report.totalCases}) cost=$${report.totalCostUsd.toFixed(6)} report=${reportPath}`,
      );
    }

    // Aggregate score across datasets
    const totalCases = reports.reduce((acc, r) => acc + r.totalCases, 0);
    const totalPassed = reports.reduce((acc, r) => acc + r.passed, 0);
    const aggregateScore =
      totalCases === 0
        ? 0
        : Math.round((totalPassed / totalCases) * 10000) / 100;

    // Print summary block (markdown-friendly so CI logs render nicely)
    const summary: string[] = [];
    summary.push('');
    summary.push('## Eval Summary');
    summary.push('');
    summary.push('| Agent | Score | Passed | Failed | Cost (USD) |');
    summary.push('|-------|-------|--------|--------|------------|');
    for (const r of reports) {
      summary.push(
        `| ${r.agentName} | ${r.scorePercent}% | ${r.passed} | ${r.failed} | $${r.totalCostUsd.toFixed(6)} |`,
      );
    }
    summary.push('');
    summary.push(
      `**Aggregate**: ${aggregateScore}% (${totalPassed}/${totalCases}) — threshold ${PASS_THRESHOLD}%`,
    );
    // eslint-disable-next-line no-console
    console.log(summary.join('\n'));

    if (aggregateScore < PASS_THRESHOLD) {
      logger.error(
        `Eval suite FAILED: aggregate ${aggregateScore}% < threshold ${PASS_THRESHOLD}%`,
      );
      return 1;
    }
    logger.log(
      `Eval suite PASSED: aggregate ${aggregateScore}% >= threshold ${PASS_THRESHOLD}%`,
    );
    return 0;
  } catch (err: any) {
    logger.error(`CLI fatal: ${err?.message ?? 'unknown'}`);
    if (err?.stack) logger.error(err.stack);
    return 1;
  } finally {
    await app.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    // Defensive: should already be caught inside main(). Logged here only
    // for the truly unexpected.
    // eslint-disable-next-line no-console
    console.error('[evals/cli] uncaught:', err);
    process.exit(1);
  });
