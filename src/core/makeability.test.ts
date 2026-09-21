import { describe, it, expect } from "vitest";
import { makeabilityFrom, perUnitConsumption, shortfallFor, type MaterialNeed } from "./makeability";

/** Whether the cloth on the shelf will make what somebody just asked for. */

const fabric: MaterialNeed = {
  materialId: "m-fabric",
  materialCode: "FAB-LINEN",
  standardConsumption: "2",
  wasteRate: "0.05",
};
const buttons: MaterialNeed = {
  materialId: "m-buttons",
  materialCode: "BTN-6",
  standardConsumption: "6",
  wasteRate: "0",
};

describe("what one garment takes", () => {
  it("includes the waste the cutting table actually consumes", () => {
    expect(perUnitConsumption(fabric).toString()).toBe("2.1");
  });

  it("leaves a waste-free line alone", () => {
    expect(perUnitConsumption(buttons).toString()).toBe("6");
  });
});

describe("how many can be made", () => {
  it("answers in whole garments, because half a coat is nothing", () => {
    // 10 metres at 2.1 a garment is four and a bit.
    const v = makeabilityFrom([fabric], new Map([["m-fabric", "10"]]));
    expect(v.makeable).toBe(4);
  });

  it("is limited by whichever material runs out first, and names it", () => {
    const v = makeabilityFrom(
      [fabric, buttons],
      new Map([
        ["m-fabric", "100"], // 47 garments
        ["m-buttons", "30"], // 5 garments
      ]),
    );
    expect(v.makeable).toBe(5);
    expect(v.limitedBy?.materialCode).toBe("BTN-6");
  });

  it("makes nothing from a material that is not there at all", () => {
    const v = makeabilityFrom([fabric], new Map());
    expect(v.makeable).toBe(0);
    expect(v.limitedBy?.materialCode).toBe("FAB-LINEN");
  });

  it("makes nothing from a style with no bill", () => {
    // Not a quibble: a style with no bill has never been costed and a run
    // cannot be raised against it, so "unlimited" would promise a garment the
    // factory would refuse to start.
    const v = makeabilityFrom([], new Map([["m-fabric", "1000"]]));
    expect(v.makeable).toBe(0);
    expect(v.limitedBy).toBeNull();
  });

  it("does not let one mistyped line make a style look unlimited", () => {
    const mistyped: MaterialNeed = { ...buttons, standardConsumption: "0" };
    const v = makeabilityFrom([fabric, mistyped], new Map([["m-fabric", "4.2"]]));
    expect(v.makeable).toBe(2);
    expect(v.limitedBy?.materialCode).toBe("FAB-LINEN");
  });

  it("counts exactly to the metre without rounding a garment into existence", () => {
    const v = makeabilityFrom([fabric], new Map([["m-fabric", "6.29"]]));
    expect(v.makeable).toBe(2);
    expect(makeabilityFrom([fabric], new Map([["m-fabric", "6.3"]])).makeable).toBe(3);
  });
});

describe("what is missing", () => {
  it("says how much more is needed, by material", () => {
    const short = shortfallFor([fabric, buttons], new Map([["m-fabric", "10"], ["m-buttons", "30"]]), 6);
    expect(short.map((s) => s.materialCode)).toEqual(["FAB-LINEN", "BTN-6"]);
    // 6 × 2.1 = 12.6 needed, 10 on hand.
    expect(short[0].short.toString()).toBe("2.6");
    expect(short[1].short.toString()).toBe("6");
  });

  it("says nothing when there is enough", () => {
    expect(shortfallFor([fabric], new Map([["m-fabric", "21"]]), 10)).toEqual([]);
  });
});
