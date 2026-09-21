using Acceptance.Core;

namespace Acceptance.Tests;

[TestClass]
public sealed class LoyaltyDiscountTests
{
    [TestMethod]
    public void ExactlyThresholdIsNotDiscounted()
    {
        Assert.AreEqual(100m, LoyaltyDiscount.Apply(100m, isLoyalCustomer: true));
    }

    [TestMethod]
    public void AboveThresholdIsDiscounted()
    {
        Assert.AreEqual(90.90m, LoyaltyDiscount.Apply(101m, isLoyalCustomer: true));
    }

    [TestMethod]
    public void NonLoyalCustomerIsUnchanged()
    {
        Assert.AreEqual(250m, LoyaltyDiscount.Apply(250m, isLoyalCustomer: false));
    }

    [TestMethod]
    public void NegativeTotalIsRejected()
    {
        Assert.ThrowsExactly<ArgumentOutOfRangeException>(
            () => LoyaltyDiscount.Apply(-1m, isLoyalCustomer: true));
    }
}
