const { ConvertDecimals, createFormatFunction, createObjectFromDefaultProps } = require("@uma/common");
import assert from "assert";

export class RangeTrader {
  readonly logger: any;
  readonly web3: any;
  readonly tokenPriceFeed: any;
  readonly referencePriceFeed: any;
  readonly normalizePriceFeedDecimals: any;
  readonly formatDecimalString: any;
  readonly exchangeAdapter: any;

  // TODO: is there any way to not have to declare these as part of the type?
  readonly BN: any;
  readonly toBN: any;
  readonly toWei: any;
  readonly fromWei: any;

  readonly tradeExecutionThreshold: any;
  readonly targetPriceSpread: any;
  readonly fixedPointAdjustment: any;

  constructor(
    /**
   * @notice Constructs new Range Trader.
   * @param {Object} logger Module used to send logs.
   * @param {Object} web3 Provider from Truffle/node  to connect to Ethereum network.
   * @param {Object} tokenPriceFeed Price feed to fetch the current synthetic token trading price. EG a Dex price feed.
   * @param {Object} referencePriceFeed Price feed to fetch the "real" identifier price. EG a Cryptowatch price feed.
   * @param {Object} exchangeAdapter Interface to interact with on-chain exchange. EG: Uniswap.
   * @param {Object} rangeTraderConfig: Config to parameterize the range trader. Expected:
   *      { tradeExecutionThreshold: 0.2,  -> error amount which must be exceeded for a correcting trade to be executed.
            targetPriceSpread: 0.05 }      -> target price that should be present after a correcting trade has concluded.
   */
    logger: any,
    web3: any,
    tokenPriceFeed: any,
    referencePriceFeed: any,
    exchangeAdapter: any,
    rangeTraderConfig: any
  ) {
    assert(tokenPriceFeed.priceFeedDecimals === referencePriceFeed.priceFeedDecimals, "pricefeed decimals must match");

    this.logger = logger;
    this.web3 = web3;
    this.tokenPriceFeed = tokenPriceFeed;
    this.referencePriceFeed = referencePriceFeed;
    this.exchangeAdapter = exchangeAdapter;

    this.normalizePriceFeedDecimals = ConvertDecimals(tokenPriceFeed.priceFeedDecimals, 18, this.web3);

    // Formats an 18 decimal point string with a define number of decimals and precision for use in message generation.
    this.formatDecimalString = createFormatFunction(this.web3, 2, 4, false);

    // Helper functions from web3.
    this.BN = this.web3.utils.BN;
    this.toBN = this.web3.utils.toBN;
    this.toWei = this.web3.utils.toWei;
    this.fromWei = this.web3.utils.fromWei;

    // Default config settings.
    const defaultConfig = {
      tradeExecutionThreshold: {
        value: 0.2,
        isValid: (x: number) => {
          return x > 0;
        }
      },
      targetPriceSpread: {
        value: 0.05,
        isValid: (x: number) => {
          return x > 0 && x <= 1;
        }
      }
    };

    // Validate and set config settings to class state.
    const configWithDefaults = createObjectFromDefaultProps(rangeTraderConfig, defaultConfig);
    Object.assign(this, configWithDefaults);

    this.fixedPointAdjustment = this.toBN(this.toWei("1"));
  }

  async update() {
    await Promise.all([this.tokenPriceFeed.update(), this.referencePriceFeed.update()]);
  }

  async checkRangeMovementsAndTrade() {
    this.logger.debug({
      at: "RangeTrader",
      message: "Checking if the priceFeed error exceeds the threshold",
      tradeExecutionThreshold: this.tradeExecutionThreshold,
      targetPriceSpread: this.targetPriceSpread
    });
    const currentTokenPrice = this.tokenPriceFeed.getCurrentPrice();
    const currentReferencePrice = this.referencePriceFeed.getCurrentPrice();

    if (!currentTokenPrice || !currentReferencePrice) {
      this.logger.warn({
        at: "RangeTrader",
        message: "Failed to get either the currentTokenPrice or the currentReferencePrice!",
        currentTokenPrice: currentTokenPrice ? currentTokenPrice.toString() : "no data returned",
        currentReferencePrice: currentReferencePrice ? currentReferencePrice.toString() : "no data returned"
      });
      return;
    }
    const deviationError = this._calculateDeviationError(currentTokenPrice, currentReferencePrice);

    const commonLogObject = {
      tradeExecutionThreshold: this.tradeExecutionThreshold * 100 + "%",
      targetPriceSpread: this.targetPriceSpread * 100 + "%",
      preTradeTokenPrice: this.formatDecimalString(this.normalizePriceFeedDecimals(currentTokenPrice)),
      preTradeReferencePrice: this.formatDecimalString(this.normalizePriceFeedDecimals(currentReferencePrice)),
      preTradePriceDeviation: this.formatDecimalString(deviationError.muln(100)) + "%"
    };
    // If the deviation error is less then the threshold, then log and return. Else, enter trade execution logic.
    if (deviationError.abs().lt(this.toBN(this.toWei(this.tradeExecutionThreshold.toString())))) {
      this.logger.debug({
        at: "RangeTrader",
        message: "The deviationError is less than the threshold to execute a trade",
        ...commonLogObject
      });
      return;
    }
    // Calculate the desired deviation off from the targetPrice feed, as a scalar quantity. If deviationError > 0 then
    // scalar = targetPriceSpread + 1. For example, if the traded price of a token is 1250 with a "true" price of 1000
    // then the deviation error is δ = (observed - expected) / expected = (1250 - 1000) / 1000 = 0.25.
    // As the error is positive (and larger than the threshold) the scalar = 1 + 0.05 = 1.05. The bot will therefore
    // try to trade the price down to 1.05x the desired price, or 1050. Similarly, if deviationError < 0 then
    // scalar = targetPriceSpread - 1. If the synthetic was trading at 800 then δ = (750 - 1000) / 1000 = -0.25 then the
    // the scalar = 1 - 0.05 = 0.95. Therefore the bot will trade the price up to 950.
    const priceScalar = deviationError.gte(this.toBN("0")) ? 1 + this.targetPriceSpread : 1 - this.targetPriceSpread;

    const desiredPrice = currentReferencePrice
      .mul(this.toBN(this.toWei(priceScalar.toString())))
      .div(this.fixedPointAdjustment);

    this.logger.debug({
      at: "RangeTrader",
      message: "The deviationError is greater than the threshold to execute a trade. Executing a correcting trade",
      ...commonLogObject,
      priceScalar,
      desiredPrice: this.formatDecimalString(this.normalizePriceFeedDecimals(desiredPrice))
    });

    const tradeExecutionTransaction = await this.exchangeAdapter.tradeMarketToDesiredPrice(desiredPrice.toString());
    if (tradeExecutionTransaction instanceof Error) {
      this.logger.error({
        at: "RangeTrader",
        message: "The exchange adapter returned an error in execution",
        ...commonLogObject,
        error: tradeExecutionTransaction
      });
      return;
    }
    const exchangeSpotPriceAfterTrade = await this.exchangeAdapter.getExchangeSpotPrice();

    const postTradePriceDeviationError = this._calculateDeviationError(
      exchangeSpotPriceAfterTrade,
      currentReferencePrice
    );

    this.logger.info({
      at: "RangeTrader",
      message: "The exchange adapter has executed a trade successfully 👉 👈",
      ...commonLogObject,
      postTradeSpotPrice: this.formatDecimalString(exchangeSpotPriceAfterTrade),
      postTradePriceDeviationError: this.formatDecimalString(postTradePriceDeviationError.muln(100)) + "%",
      tx: tradeExecutionTransaction.transactionHash
    });
  }

  // TODO: replace the any type with bignumber types. I'm not exactly sure what the best practice is to do this in typescript.
  // TODO: this method was taken from the SyntheticPegMonitor verbatim. Ideally it should be refactored into a common utility that both can use.
  _calculateDeviationError(observedValue: any, expectedValue: any) {
    return this.normalizePriceFeedDecimals(observedValue)
      .sub(this.normalizePriceFeedDecimals(expectedValue))
      .mul(this.fixedPointAdjustment) // Scale the numerator before division
      .div(this.normalizePriceFeedDecimals(expectedValue));
  }
}

module.exports = { RangeTrader };
