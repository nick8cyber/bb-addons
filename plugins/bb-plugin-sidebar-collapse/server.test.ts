import {describe,it,expect,vi} from "vitest";
import {createFakePluginHost} from "@get-bb/plugin-sdk/testing";
import plugin,{selectThreadList} from "./server";

function setup(initial="sidebar-collapse/collapsed"){
  let value=initial,revision=1;
  const list=vi.fn(async()=>({preferences:{"sidebar.threadListProvider":{value,revision}}}));
  const set=vi.fn(async(args:{value:string;expectedRevision:number})=>{
    if(args.expectedRevision!==revision)throw Error("revision-conflict");
    value=args.value;revision++;return {key:"sidebar.threadListProvider",value,revision};
  });
  const h=createFakePluginHost({pluginId:"sidebar-collapse",sdk:{system:{uiPreferences:{list,set}}}});
  return {...h,list,set};
}
describe("native list selection without removed Original prop",()=>{
  it("switches Automatic to native and back to Sidebar Collapse",async()=>{
    const h=setup("__automatic__");await plugin(h.bb);
    await h.harness.behavior.setSettings({useCollapsedList:false});
    await vi.waitFor(()=>expect(h.set).toHaveBeenCalledWith({key:"sidebar.threadListProvider",value:"thread-list/thread-list",expectedRevision:1}));
    await h.harness.behavior.setSettings({useCollapsedList:true});
    await vi.waitFor(()=>expect(h.set).toHaveBeenCalledWith({key:"sidebar.threadListProvider",value:"sidebar-collapse/collapsed",expectedRevision:2}));
    await h.harness.lifecycle.dispose();
  });
  it("does not write preferences at startup; false then true selects each list",async()=>{
    const h=setup();await plugin(h.bb);expect(h.set).not.toHaveBeenCalled();
    await h.harness.behavior.setSettings({useCollapsedList:false});
    await vi.waitFor(()=>expect(h.set).toHaveBeenCalledWith({key:"sidebar.threadListProvider",value:"thread-list/thread-list",expectedRevision:1}));
    await h.harness.behavior.setSettings({useCollapsedList:true});
    await vi.waitFor(()=>expect(h.set).toHaveBeenCalledWith({key:"sidebar.threadListProvider",value:"sidebar-collapse/collapsed",expectedRevision:2}));
    await h.harness.lifecycle.dispose();
  });
  it("keeps another plugin selection intact",async()=>{
    const h=setup("other/list");expect(await selectThreadList(h.bb,false)).toBe(false);
    expect(h.set).not.toHaveBeenCalled();await h.harness.lifecycle.dispose();
  });
  it("does not write when already selected or disposed",async()=>{
    const h=setup("thread-list/thread-list");
    expect(await selectThreadList(h.bb,false)).toBe(false);
    expect(await selectThreadList(h.bb,true,()=>true)).toBe(false);
    expect(h.set).not.toHaveBeenCalled();await h.harness.lifecycle.dispose();
  });
  it("propagates CAS failure instead of overwriting another choice",async()=>{
    const h=setup();h.set.mockRejectedValueOnce(Error("revision-conflict"));
    await expect(selectThreadList(h.bb,false)).rejects.toThrow("revision-conflict");
    expect(h.set).toHaveBeenCalledTimes(1);await h.harness.lifecycle.dispose();
  });
  it("does not select a list on rail changes; fallback RPC selects native",async()=>{
    const h=setup();await plugin(h.bb);
    await h.harness.behavior.setSettings({hideNavigationRail:true});
    expect(h.set).not.toHaveBeenCalled();
    await h.harness.behavior.callRpc("show_native_list",{});
    await vi.waitFor(()=>expect(h.set).toHaveBeenCalledTimes(1));
    expect(h.set.mock.calls[0]?.[0]).toMatchObject({key:"sidebar.threadListProvider",value:"thread-list/thread-list"});
    await h.harness.lifecycle.dispose();
  });
});
