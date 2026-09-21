namespace Acceptance.Core;

public static class LoyaltyDiscount
{
    public static decimal Apply(decimal total, bool isLoyalCustomer)
    {
        if (total < 0)
        {
            throw new ArgumentOutOfRangeException(nameof(total));
        }

        if (!isLoyalCustomer)
        {
            return total;
        }

        // Intentional v0 acceptance bug:
        // the discount must apply only when total is strictly greater than 100.
        return total >= 100m
            ? total * 0.90m
            : total;
    }
}
