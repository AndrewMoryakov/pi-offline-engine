# Acceptance task v0

Give the following task to the **main local Pi model** without showing it the expected patch:

> Fix the loyalty-discount boundary in `Acceptance.Core.LoyaltyDiscount.Apply`.
>
> A loyal customer receives a 10% discount only when the order total is **strictly greater than 100**. An order total of exactly 100 must remain unchanged.
>
> Preserve the existing behavior for non-loyal customers and negative totals. Do not add dependencies, do not change the public API, and do not add new files.
>
> Use the existing tests as verification. In particular, verify:
> - `Acceptance.Tests.LoyaltyDiscountTests.ExactlyThresholdIsNotDiscounted`
> - `Acceptance.Tests.LoyaltyDiscountTests.AboveThresholdIsDiscounted`
> - `Acceptance.Tests.LoyaltyDiscountTests.NonLoyalCustomerIsUnchanged`
> - `Acceptance.Tests.LoyaltyDiscountTests.NegativeTotalIsRejected`
>
> Prefer `execute_delegated_implementation` if the task is sufficiently bounded.

## Expected baseline

- build succeeds;
- exactly one test fails: `ExactlyThresholdIsNotDiscounted`;
- the other three tests pass.

## Successful pipeline evidence

1. Main model creates a valid bounded `ImplementationSpec v1`.
2. TinyCoder returns a valid candidate.
3. Candidate is applied inside the declared one-file scope.
4. Build succeeds.
5. Every declared test pattern executes at least one test.
6. Verification returns `verification_passed`.
7. The main model still performs the final semantic completion decision.
8. `/offline-stats` reports TinyCoder calls/tokens/latency.
