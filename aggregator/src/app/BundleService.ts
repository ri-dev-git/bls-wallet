import {
  BigNumber,
  BlsWalletSigner,
  Bundle,
  delay,
  ERC20,
  ERC20__factory,
  ethers,
  QueryClient,
} from "../../deps.ts";

import { IClock } from "../helpers/Clock.ts";
import Mutex from "../helpers/Mutex.ts";
import toShortPublicKey from "./helpers/toPublicKeyShort.ts";
import nil from "../helpers/nil.ts";
import Range from "../helpers/Range.ts";
import assert from "../helpers/assert.ts";

import TransactionFailure from "./TransactionFailure.ts";
import SubmissionTimer from "./SubmissionTimer.ts";
import * as env from "../env.ts";
import runQueryGroup from "./runQueryGroup.ts";
import EthereumService from "./EthereumService.ts";
import AppEvent from "./AppEvent.ts";
import BundleTable, { BundleRow } from "./BundleTable.ts";

export default class BundleService {
  static defaultConfig = {
    bundleQueryLimit: env.BUNDLE_QUERY_LIMIT,
    maxAggregationSize: env.MAX_AGGREGATION_SIZE,
    maxAggregationDelayMillis: env.MAX_AGGREGATION_DELAY_MILLIS,
    maxUnconfirmedAggregations: env.MAX_UNCONFIRMED_AGGREGATIONS,
    maxEligibilityDelay: env.MAX_ELIGIBILITY_DELAY,
    rewards: {
      type: env.REWARD_TYPE,
      perGas: env.REWARD_PER_GAS,
      perByte: env.REWARD_PER_BYTE,
    },
  };

  unconfirmedBundles = new Set<Bundle>();
  unconfirmedActionCount = 0;
  unconfirmedRowIds = new Set<number>();

  submissionTimer: SubmissionTimer;
  submissionsInProgress = 0;

  stopping = false;
  stopped = false;
  pendingTaskPromises = new Set<Promise<unknown>>();

  constructor(
    public emit: (evt: AppEvent) => void,
    public clock: IClock,
    public queryClient: QueryClient,
    public bundleTableMutex: Mutex,
    public bundleTable: BundleTable,
    public blsWalletSigner: BlsWalletSigner,
    public ethereumService: EthereumService,
    public config = BundleService.defaultConfig,
  ) {
    this.submissionTimer = new SubmissionTimer(
      clock,
      config.maxAggregationDelayMillis,
      () => this.runSubmission(),
    );

    (async () => {
      await delay(100);

      while (!this.stopping) {
        this.tryAggregating();
        // TODO (merge-ok): Stop if there aren't any bundles?
        await this.ethereumService.waitForNextBlock();
      }
    })();
  }

  async stop() {
    this.stopping = true;
    await Promise.all(Array.from(this.pendingTaskPromises));
    this.stopped = true;
  }

  async runPendingTasks() {
    while (this.pendingTaskPromises.size > 0) {
      await Promise.all(Array.from(this.pendingTaskPromises));
    }
  }

  addTask(task: () => Promise<unknown>) {
    if (this.stopping) {
      return;
    }

    const promise = task().catch(() => {});
    this.pendingTaskPromises.add(promise);
    promise.then(() => this.pendingTaskPromises.delete(promise));
  }

  async tryAggregating() {
    if (this.submissionsInProgress > 0) {
      // No need to check because there is already a submission in progress, and
      // a new check is run after every submission.
      return;
    }

    const eligibleRows = await this.bundleTable.findEligible(
      await this.ethereumService.BlockNumber(),
      this.config.bundleQueryLimit,
    );

    const actionCount = eligibleRows
      .filter((r) => !this.unconfirmedRowIds.has(r.id!))
      .map((r) => countActions(r.bundle))
      .reduce(plus, 0);

    if (actionCount >= this.config.maxAggregationSize) {
      this.submissionTimer.trigger();
    } else if (actionCount > 0) {
      this.submissionTimer.notifyActive();
    } else {
      this.submissionTimer.clear();
    }
  }

  runQueryGroup<T>(body: () => Promise<T>): Promise<T> {
    return runQueryGroup(
      this.emit,
      this.bundleTableMutex,
      this.queryClient,
      body,
    );
  }

  async add(bundle: Bundle): Promise<TransactionFailure[]> {
    if (bundle.operations.length !== bundle.senderPublicKeys.length) {
      return [
        {
          type: "invalid-format",
          description:
            "number of operations does not match number of public keys",
        },
      ];
    }

    const signedCorrectly = this.blsWalletSigner.verify(bundle);

    const failures: TransactionFailure[] = [];

    if (signedCorrectly === false) {
      failures.push({
        type: "invalid-signature",
        description: "invalid signature",
      });
    }

    failures.push(...await this.ethereumService.checkNonces(bundle));

    if (failures.length > 0) {
      return failures;
    }

    return await this.runQueryGroup(async () => {
      await this.bundleTable.add({
        bundle,
        eligibleAfter: await this.ethereumService.BlockNumber(),
        nextEligibilityDelay: BigNumber.from(1),
      });

      this.emit({
        type: "bundle-added",
        data: {
          publicKeyShorts: bundle.senderPublicKeys.map(toShortPublicKey),
        },
      });

      this.addTask(() => this.tryAggregating());

      return [];
    });
  }

  async runSubmission() {
    this.submissionsInProgress++;

    const submissionResult = await this.runQueryGroup(async () => {
      const currentBlockNumber = await this.ethereumService.BlockNumber();

      const eligibleRows = await this.bundleTable.findEligible(
        currentBlockNumber,
        this.config.bundleQueryLimit,
      );

      const { aggregateBundle, includedRows } = await this
        .createAggregateBundle(eligibleRows);

      if (!aggregateBundle || includedRows.length === 0) {
        return;
      }

      await this.submitAggregateBundle(
        aggregateBundle,
        includedRows,
      );
    });

    this.submissionsInProgress--;
    this.addTask(() => this.tryAggregating());

    return submissionResult;
  }

  async createAggregateBundle(eligibleRows: BundleRow[]): (
    Promise<{
      aggregateBundle: Bundle | nil;
      includedRows: BundleRow[];
    }>
  ) {
    let aggregateBundle = this.blsWalletSigner.aggregate([]);
    const includedRows: BundleRow[] = [];

    while (eligibleRows.length > 0) {
      const {
        aggregateBundle: newAggregateBundle,
        includedRows: newIncludedRows,
        remainingEligibleRows,
      } = await this.augmentAggregateBundle(
        aggregateBundle,
        eligibleRows,
      );

      aggregateBundle = newAggregateBundle;
      includedRows.push(...newIncludedRows);
      eligibleRows = remainingEligibleRows;
    }

    return {
      aggregateBundle: aggregateBundle.operations.length > 0
        ? aggregateBundle
        : nil,
      includedRows,
      // TODO: Return failedRows rather than processing failures as a side
      // effect?
    };
  }

  async augmentAggregateBundle(
    previousAggregateBundle: Bundle,
    eligibleRows: BundleRow[],
  ): (
    Promise<{
      aggregateBundle: Bundle;
      includedRows: BundleRow[];
      remainingEligibleRows: BundleRow[];
    }>
  ) {
    let aggregateBundle: Bundle | nil = nil;
    let includedRows: BundleRow[] = [];
    // TODO (merge-ok): Count gas instead, have idea
    // or way to query max gas per txn (submission).
    let actionCount = countActions(previousAggregateBundle);

    for (const row of eligibleRows) {
      if (this.unconfirmedRowIds.has(row.id!)) {
        continue;
      }

      const rowActionCount = countActions(row.bundle);

      if (actionCount + rowActionCount > this.config.maxAggregationSize) {
        break;
      }

      includedRows.push(row);
      actionCount += rowActionCount;
    }

    // FIXME: measureRewards should be aware of previousAggregateBundle and
    // avoid redundantly measuring its reward.
    const rewards = (await this.measureRewards([
      previousAggregateBundle,
      ...includedRows.map((r) => r.bundle),
    ])).slice(1);

    const firstFailureIndex = await this.findFirstFailureIndex(
      previousAggregateBundle,
      includedRows.map((r) => r.bundle),
      rewards,
    );

    let remainingEligibleRows: BundleRow[];

    if (firstFailureIndex !== nil) {
      const failedRow = includedRows[firstFailureIndex];

      includedRows = includedRows.slice(
        0,
        firstFailureIndex,
      );

      // TODO: Should this be a task?
      await this.handleFailedRow(
        failedRow,
        await this.ethereumService.BlockNumber(),
      );

      const eligibleRowIndex = eligibleRows.indexOf(failedRow);
      assert(eligibleRowIndex !== -1);

      remainingEligibleRows = eligibleRows.slice(includedRows.length + 1);
    } else {
      remainingEligibleRows = eligibleRows.slice(includedRows.length);
    }

    aggregateBundle = this.blsWalletSigner.aggregate([
      previousAggregateBundle,
      ...includedRows.map((r) => r.bundle),
    ]);

    return {
      aggregateBundle,
      includedRows,
      remainingEligibleRows,
    };
  }

  async measureRewards(bundles: Bundle[]): Promise<{
    success: boolean;
    reward: BigNumber;
  }[]> {
    const es = this.ethereumService;

    const rewardToken = this.RewardToken();

    // TODO: Test including a failing action. There probably needs to be some
    // extra logic to handle that.
    const { measureResults, callResults: processBundleResults } = await es
      .callStaticSequenceWithMeasure(
        rewardToken
          ? es.Call(rewardToken, "balanceOf", [es.wallet.address])
          : es.Call(es.utilities, "ethBalanceOf", [es.wallet.address]),
        bundles.map((bundle) =>
          es.Call(
            es.verificationGateway,
            "processBundle",
            [bundle],
          )
        ),
      );

    return Range(bundles.length).map((i) => {
      const [before, after] = [measureResults[i], measureResults[i + 1]];
      assert(before.success);
      assert(after.success);

      const bundleResult = processBundleResults[i];

      let success: boolean;

      if (bundleResult.success) {
        const [operationResults] = bundleResult.returnValue;

        // We require that at least one operation succeeds, even though
        // processBundle doesn't revert in this case.
        success = operationResults.some((opSuccess) => opSuccess === true);
      } else {
        success = false;
      }

      const reward = after.returnValue[0].sub(before.returnValue[0]);

      return { success, reward };
    });
  }

  RewardToken(): ERC20 | nil {
    const rewardType = this.config.rewards.type;

    if (rewardType === "ether") {
      return nil;
    }

    return ERC20__factory.connect(
      rewardType.slice("token:".length),
      this.ethereumService.wallet.provider,
    );
  }

  async measureRequiredReward(bundle: Bundle) {
    const gasEstimate = await this.ethereumService.verificationGateway
      .estimateGas
      .processBundle(bundle);

    const callDataSize = ethers.utils.hexDataLength(
      this.ethereumService.verificationGateway.interface
        .encodeFunctionData("processBundle", [bundle]),
    );

    return (
      gasEstimate.mul(this.config.rewards.perGas).add(
        this.config.rewards.perByte.mul(callDataSize),
      )
    );
  }

  /**
   * Get a lower bound for the reward that is required for processing the
   * bundle.
   *
   * This exists because it's a very good lower bound and it's very fast.
   * Therefore, when there's an insufficient reward bundle:
   * - This lower bound is usually enough to find it
   * - Finding it this way is much more efficient
   */
  measureRequiredRewardLowerBound(bundle: Bundle) {
    const callDataSize = ethers.utils.hexDataLength(
      this.ethereumService.verificationGateway.interface
        .encodeFunctionData("processBundle", [bundle]),
    );

    return this.config.rewards.perByte.mul(callDataSize);
  }

  async findFirstFailureIndex(
    previousAggregateBundle: Bundle,
    bundles: Bundle[],
    rewards: { success: boolean; reward: BigNumber }[],
  ): Promise<number | nil> {
    if (bundles.length === 0) {
      return nil;
    }

    const len = bundles.length;
    assert(rewards.length === len);

    const checkFirstN = async (n: number): Promise<{
      success: boolean;
      reward: BigNumber;
      requiredReward: BigNumber;
    }> => {
      if (n === 0) {
        return {
          success: true,
          reward: BigNumber.from(0),
          requiredReward: BigNumber.from(0),
        };
      }

      const reward = bigSum(rewards.slice(0, n).map((r) => r.reward));

      const requiredReward = await this.measureRequiredReward(
        this.blsWalletSigner.aggregate([
          previousAggregateBundle,
          ...bundles.slice(0, n),
        ]),
      );

      const success = reward.gte(requiredReward);

      return { success, reward, requiredReward };
    };

    // This calculation is entirely local and cheap. It can find a failing
    // bundle, but it might not be the *first* failing bundle.
    const fastFailureIndex = (() => {
      for (let i = 0; i < len; i++) {
        // If the actual call failed then we consider it a failure, even if the
        // reward is somehow met (e.g. if zero reward is required).
        if (rewards[i].success === false) {
          return i;
        }

        // Because the required reward mostly comes from the calldata size, this
        // should find the first insufficient reward most of the time.
        const lowerBound = this.measureRequiredRewardLowerBound(bundles[i]);

        if (rewards[i].reward.lt(lowerBound)) {
          return i;
        }
      }
    })();

    let left = 0;
    let leftRequiredReward = BigNumber.from(0);
    let right: number;
    let rightRequiredReward: BigNumber;

    if (fastFailureIndex !== nil) {
      // Having a fast failure index is not enough because it might not be the
      // first. To establish that it really is the first, we need to ensure that
      // all bundles up to that index are ok (indeed, this is the assumption
      // that is relied upon outside - that the subset before the first failing
      // index can proceed without further checking).

      const { success, requiredReward } = await checkFirstN(fastFailureIndex);

      if (success) {
        return fastFailureIndex;
      }

      // In case of failure, we now know there as a failing index in a more
      // narrow range, so we can at least restrict the bisect to this smaller
      // range.
      right = fastFailureIndex;
      rightRequiredReward = requiredReward;
    } else {
      // If we don't have a failing index, we still need to establish that there
      // is a failing index to be found. This is because it's a requirement of
      // the upcoming bisect logic that there is a failing bundle in
      // `bundles.slice(left, right)`.

      const { success, requiredReward } = await checkFirstN(bundles.length);

      if (success) {
        return nil;
      }

      right = bundles.length;
      rightRequiredReward = requiredReward;
    }

    // Do a bisect to narrow in on the (first) culprit.
    while (right - left > 1) {
      const mid = Math.floor((left + right) / 2);

      const { success, requiredReward } = await checkFirstN(mid);

      if (success) {
        left = mid;
        leftRequiredReward = requiredReward;
      } else {
        right = mid;
        rightRequiredReward = requiredReward;
      }
    }

    assert(right - left === 1, "bisect should identify a single result");

    // The bisect procedure maintains that the culprit is a member of
    // `bundles.slice(left, right)`. That's now equivalent to `[bundles[left]]`,
    // so `left` is our culprit index.

    const bundleReward = rewards[left].reward;
    const bundleRequiredReward = rightRequiredReward.sub(leftRequiredReward);

    // Tracking the rewards so that we can include this assertion isn't strictly
    // necessary. But the cost is negligible and should help troubleshooting a
    // lot if something goes wrong.
    assert(bundleReward.lt(bundleRequiredReward));

    return left;
  }

  async handleFailedRow(row: BundleRow, currentBlockNumber: BigNumber) {
    if (row.nextEligibilityDelay.lte(this.config.maxEligibilityDelay)) {
      await this.bundleTable.update({
        ...row,
        eligibleAfter: currentBlockNumber.add(row.nextEligibilityDelay),
        nextEligibilityDelay: row.nextEligibilityDelay.mul(2),
      });
    } else {
      await this.bundleTable.remove(row);
    }

    this.unconfirmedRowIds.delete(row.id!);
  }

  async submitAggregateBundle(
    aggregateBundle: Bundle,
    includedRows: BundleRow[],
  ) {
    const maxUnconfirmedActions = (
      this.config.maxUnconfirmedAggregations *
      this.config.maxAggregationSize
    );

    const actionCount = countActions(aggregateBundle);

    while (
      this.unconfirmedActionCount + actionCount > maxUnconfirmedActions
    ) {
      // FIXME (merge-ok): Polling
      this.emit({ type: "waiting-unconfirmed-space" });
      await delay(1000);
    }

    this.unconfirmedActionCount += actionCount;
    this.unconfirmedBundles.add(aggregateBundle);

    for (const row of includedRows) {
      this.unconfirmedRowIds.add(row.id!);
    }

    this.addTask(async () => {
      try {
        const recpt = await this.ethereumService.submitBundle(
          aggregateBundle,
          Infinity,
          300,
        );

        this.emit({
          type: "submission-confirmed",
          data: {
            rowIds: includedRows.map((row) => row.id),
            blockNumber: recpt.blockNumber,
          },
        });

        await this.bundleTable.remove(...includedRows);
      } finally {
        this.unconfirmedActionCount -= actionCount;
        this.unconfirmedBundles.delete(aggregateBundle);

        for (const row of includedRows) {
          this.unconfirmedRowIds.delete(row.id!);
        }
      }
    });
  }

  async waitForConfirmations() {
    const startUnconfirmedBundles = [...this.unconfirmedBundles];

    while (true) {
      const allConfirmed = startUnconfirmedBundles.every(
        (bundle) => !this.unconfirmedBundles.has(bundle),
      );

      if (allConfirmed) {
        break;
      }

      // FIXME (merge-ok): Polling
      await delay(100);
    }
  }
}

function countActions(bundle: Bundle) {
  return bundle.operations.map((op) => op.actions.length).reduce(plus, 0);
}

function plus(a: number, b: number) {
  return a + b;
}

function bigSum(values: BigNumber[]) {
  return values.reduce((a, b) => a.add(b), BigNumber.from(0));
}
