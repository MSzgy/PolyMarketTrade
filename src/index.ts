import { loadConfig } from "./config.js";
import { loadEnvFile } from "./lib/env-file.js";
import { Logger } from "./lib/logger.js";
import { ClobService } from "./polymarket/clob-service.js";
import { TradingRunner } from "./runner.js";
import { PriceThresholdStrategy } from "./strategies/price-threshold.js";

async function main(): Promise<void> {
  loadEnvFile(".env");

  const config = loadConfig();
  const logger = new Logger(config.logLevel);
  const clobService = new ClobService(config);
  const strategy = new PriceThresholdStrategy({
    buyBelowPrice: config.buyBelowPrice,
    orderSize: config.orderSize,
  });
  const runner = new TradingRunner(config, strategy, clobService, logger);

  process.once("SIGINT", () => {
    logger.info("received SIGINT, stopping bot");
    runner.stop();
  });

  process.once("SIGTERM", () => {
    logger.info("received SIGTERM, stopping bot");
    runner.stop();
  });

  await runner.start();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
