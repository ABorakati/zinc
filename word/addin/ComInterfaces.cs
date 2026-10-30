using System;
using System.Runtime.InteropServices;

// Hand-declared COM interfaces so the add-in needs no Office/Extensibility interop assemblies. IIDs and member
// order were checked against the installed office.dll (Microsoft.Office.Core): IRibbonExtensibility
// {000C0396}, ICustomTaskPaneConsumer {000C033E}, ICTPFactory {000C033D}; _CustomTaskPane is used late bound.
namespace ZoteroNext.Word
{
    public enum ext_ConnectMode { ext_cm_AfterStartup = 0, ext_cm_Startup = 1, ext_cm_External = 2, ext_cm_CommandLine = 3 }
    public enum ext_DisconnectMode { ext_dm_HostShutdown = 0, ext_dm_UserClosed = 1 }

    [ComImport, Guid("B65AD801-ABAF-11D0-BB8B-00A0C90F2744"), InterfaceType(ComInterfaceType.InterfaceIsDual)]
    public interface IDTExtensibility2
    {
        void OnConnection([MarshalAs(UnmanagedType.IDispatch)] object Application, ext_ConnectMode ConnectMode, [MarshalAs(UnmanagedType.IDispatch)] object AddInInst, ref Array custom);
        void OnDisconnection(ext_DisconnectMode RemoveMode, ref Array custom);
        void OnAddInsUpdate(ref Array custom);
        void OnStartupComplete(ref Array custom);
        void OnBeginShutdown(ref Array custom);
    }

    [ComImport, Guid("000C0396-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsDual)]
    public interface IRibbonExtensibility
    {
        [DispId(1)] [return: MarshalAs(UnmanagedType.BStr)] string GetCustomUI([In, MarshalAs(UnmanagedType.BStr)] string RibbonID);
    }

    [ComImport, Guid("000C033E-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsDual)]
    public interface ICustomTaskPaneConsumer
    {
        [DispId(1)] void CTPFactoryAvailable([In, MarshalAs(UnmanagedType.Interface)] ICTPFactory CTPFactoryInst);
    }

    [ComImport, Guid("000C033D-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsDual)]
    public interface ICTPFactory
    {
        [DispId(1)] [return: MarshalAs(UnmanagedType.IDispatch)]
        object CreateCTP([In, MarshalAs(UnmanagedType.BStr)] string CTPAxID, [In, MarshalAs(UnmanagedType.BStr)] string CTPTitle, [In, Optional, MarshalAs(UnmanagedType.Struct)] object CTPParentWindow);
    }
}
