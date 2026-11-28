// @effect-diagnostics nodeBuiltinImport:off -- the packaged server resolves native bindings through require.
import * as NodeModule from "node:module";
import type { FieldType, JsExternal } from "ffi-rs";

const requireNative = NodeModule.createRequire(import.meta.url);
const foundation = "t3-mail-foundation";

// NSActivityUserInitiatedAllowingIdleSystemSleep from NSProcessInfo.h.
const syncActivityOptions = 0x00ffffff & ~(1 << 20);

export function beginMacMailActivity(): () => void {
  const { DataType, isNullPointer, load, open } = requireNative(
    "ffi-rs",
  ) as typeof import("ffi-rs");
  open({ library: foundation, path: "/System/Library/Frameworks/Foundation.framework/Foundation" });
  const pointer = DataType.External;
  const lookup = (functionName: "objc_getClass" | "sel_registerName", name: string) =>
    load({
      library: foundation,
      funcName: functionName,
      retType: pointer,
      paramsType: [DataType.String],
      paramsValue: [name],
    });
  const message = <T extends FieldType>(
    target: JsExternal,
    selector: string,
    retType: T,
    types: FieldType[] = [],
    args: unknown[] = [],
  ) =>
    load({
      library: foundation,
      funcName: "objc_msgSend",
      retType,
      paramsType: [pointer, pointer, ...types],
      paramsValue: [target, lookup("sel_registerName", selector), ...args],
    });

  // Node may have no surrounding Cocoa autorelease pool. Only the retained token escapes it.
  const pool = message(lookup("objc_getClass", "NSAutoreleasePool"), "new", pointer);
  try {
    const info = message(lookup("objc_getClass", "NSProcessInfo"), "processInfo", pointer);
    const reason = message(
      lookup("objc_getClass", "NSString"),
      "stringWithUTF8String:",
      pointer,
      [DataType.String],
      ["Code + Mailbox sync"],
    );
    const activity = message(
      info,
      "beginActivityWithOptions:reason:",
      pointer,
      [DataType.U64, pointer],
      [syncActivityOptions, reason],
    );
    if (isNullPointer(activity)) throw new Error("Foundation returned no mail activity");
    message(activity, "retain", pointer);
    return () => {
      message(info, "endActivity:", DataType.Void, [pointer], [activity]);
      message(activity, "release", DataType.Void);
    };
  } finally {
    message(pool, "drain", DataType.Void);
  }
}
