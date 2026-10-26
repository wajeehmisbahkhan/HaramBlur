# Privacy Policy — HaramBlur Family (unofficial fork)

_Last updated: 26 October 2026_

HaramBlur Family is a browser extension that detects and blurs unwanted images and videos on web pages. This policy explains what data it handles. In short: **it does not collect, store or transmit any personal data, and it has no servers of its own.**

## Web page content

To decide what to blur, the extension reads the images and video frames on the pages you visit. All of this analysis happens **on your device**, using machine-learning models that run inside the browser. Images and video frames are never uploaded, saved or shared. To analyse an image, the extension may load it again from the address the page already uses, just as the page itself does.

## Settings

Your preferences (on/off state, blur amount, strictness, which media and faces to blur, and sites you choose to exclude) are saved using Chrome's built-in `chrome.storage.sync`. If Chrome sync is turned on, Google syncs these settings between your own devices under your Google account, as described in [Google's Privacy Policy](https://policies.google.com/privacy). The developer has no access to them.

## Network requests

The extension makes no requests to any server run by the developer. The only network requests it makes are:

-   **Detection model files**, downloaded from [jsDelivr](https://www.jsdelivr.com/terms/privacy-policy-jsdelivr-net) (cdn.jsdelivr.net), a public content delivery network. As with any web request, jsDelivr receives your IP address and browser details. No page content or personal data is sent.
-   **Icons shown in the extension's popup**, loaded from static.addtoany.com and coothead.co.uk when you open the popup. These receive the same standard request information.

The popup also contains links (sharing buttons, a feedback form and the source code). They only open if you click them, and the sites they lead to have their own privacy policies.

## Data sharing and sale

No user data is collected, so none is sold, shared with third parties, used for advertising, or used for any purpose unrelated to blurring content.

## Children

The extension is intended to help parents protect children while they browse. It collects no information from anyone, including children.

## Changes

Any changes to this policy will be published at this page.

## Contact

Questions about this policy can be raised as an issue at <https://github.com/wajeehmisbahkhan/HaramBlur/issues>.
