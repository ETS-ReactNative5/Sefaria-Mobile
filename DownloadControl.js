'use strict';

import RNFB from 'rn-fetch-blob';
import {unzip} from 'react-native-zip-archive'; //for unzipping -- (https://github.com/plrthink/react-native-zip-archive)
import strings from './LocalizedStrings'
import {Alert, Platform} from 'react-native';
import AsyncStorage from "@react-native-community/async-storage";
import NetInfo from "@react-native-community/netinfo";
import Sefaria from "./sefaria";

const SCHEMA_VERSION = "6";
const DOWNLOAD_SERVER = "https://readonly.sefaria.org";
const HOST_PATH = `${DOWNLOAD_SERVER}/static/ios-export/${SCHEMA_VERSION}`;
const HOST_BUNDLE_URL = `${HOST_PATH}/bundles`;
const [FILE_DIRECTORY, TMP_DIRECTORY] = [`${RNFB.fs.dirs.DocumentDir}/library`, `${RNFB.fs.dirs.DocumentDir}/tmp`];  //todo: make sure these are used
// const TMP_DIRECTORY = `${RNFB.fs.dirs.DocumentDir}/tmp`;
console.log(`The tmp directory is: ${TMP_DIRECTORY}`);
const BUNDLE_LOCATION = `${TMP_DIRECTORY}/bundle.zip`;

let BooksState = {};
let PackagesState = {};

/*
 * A note on package tracking:
 * The PackagesState object contains detailed data on packages. This object is a combination of the file packages.json
 * and the data stored in AsyncStorage under the key packagesSelected.
 * packagesSelected is a simple mapping of packageName -> bool
 */
function selectedPackages() {
  // Test with Jest
  let selections = {};
  for (let [packageTitle, packObj] of Object.entries(PackagesState)) {
    if (packObj.wasSelectedByUser())
      selections[packageTitle] = true;
  }
  return selections
}

class DownloadTracker {
  // Test with Jest
  constructor() {
    this.currentDownload = null;
    this.subscriptions = {};
    this.removeProgressTracker(); // sets default values for the progress event listener
    this.networkEventListener = null;
    this._currentDownloadNotification = null;
  }
  addDownload(downloadState) {
    if (this.downloadInProgress()) {
      throw "Another download is in Progress!"
    }
    this.currentDownload = downloadState;
    if (!!this.progressTracker) {this.attachProgressTracker(...this.progressTracker)}
    this.notify(this._currentDownloadNotification);
  }
  removeDownload() {
    console.log('removing download');
    this.currentDownload = null;
    this.notify(null)
  }
  removeSpecificDownload(taskId) {
    if (this.currentDownload && this.currentDownload.taskId === taskId) {
      this.removeDownload();
    }
  }
  downloadInProgress() {
    return (!!this.currentDownload);
  }
  cancelDownload(cleanup=true) {
    console.log('canceling download');
    if (this.downloadInProgress()) {
      this.currentDownload.catch(e => console.log(`${e.message === 'canceled'}\n${e}`));
      this.currentDownload.cancel((err, taskId) => console.log(`canceled download ${taskId}; err is ${err}`));
      this.removeDownload();
      if (cleanup) { cleanTmpDirectory().then( () => {} ) }
    }
    else {
      // throw "No download to cancel"
    }
  }
  attachProgressTracker(progressTracker, config) {
    if (this.downloadInProgress()) {
      this.currentDownload.progress(config, progressTracker);
    } else
      this.progressTracker = [progressTracker, config];
  }
  removeProgressTracker() {
    const config = {count: 20, interval: 250};
    const logger = (received, total) => !!(received) ? console.log(`downloaded ${received}/${total} bytes, which is ${received / total}`) : console.log(0.0);
    this.attachProgressTracker(logger, config);
  }
  subscribe(listenerName, listenerFunc) {
    /*
     * add a function that will be updated when downloads begin and finish. Function should accept a boolean. A
     * name must be supplied as well. This will avoid a single method subscribing multiple times, as well as allowing
     * for unsubscribing.
     */
    this.subscriptions[listenerName] = listenerFunc;
  }
  unsubscribe(listenerName) {
    delete this.subscriptions[listenerName];
  }
  notify(value) {
    /*
     * At the start of a download we should notify via the method that initiated the download. This should happen from a
     * UI component. This allows the UI component to send whatever messages it needs to down to all the components
     * listening.
     *
     * At the end of a download we'll call notify(false) from the DownloadTracker. This is because only the DownloadTracker
     * can know when a download has completed
     */
    this._currentDownloadNotification = value;
    Object.values(this.subscriptions).map(x => {
      try{
        x(value);
      } catch (e) {
        console.log(`notification error: ${e}`)
      }
    })
  }
  getDownloadStatus() {
    return this._currentDownloadNotification;
  }
  addEventListener(networkSetting, runEvent=false) {
    this.removeEventListener();  // keep things clean
    const allowedToDownload = state => isDownloadAllowed(state, networkSetting);
    const networkChangeMethod = state => {
      console.log(`network state from event listener: ${state.type}`);
      if (allowedToDownload(state)) {
        console.log('attempting to recover download');
        downloadRecover(networkSetting).then(() => {});
      } else if (Tracker.downloadInProgress()){
        console.log('canceling active download');
        Tracker.cancelDownload(false);
      }
    };
    this.networkEventListener = NetInfo.addEventListener(networkChangeMethod);
    if (runEvent) { NetInfo.fetch().then(networkChangeMethod) }  // simulates an event so we can trigger the worker manually
  }
  removeEventListener() {
    if (!!this.networkEventListener) {
      this.networkEventListener();  // calling the event listener unsubscribes
      this.networkEventListener = null;
    }
  }
}

const Tracker = new DownloadTracker();

class Package {
  // Test with Jest
  constructor(jsonData, order=0) {
    this.name = jsonData['en'];
    this.jsonData = jsonData;
    this.children = [];
    this.supersededByParent = false;
    this.clicked = false;
    this.parent = this.getParent();
    this.order = order;
  }
  addChild = function (child) {
    this.children.push(child);
  };
  getParent = function () {
    if (this.name === 'COMPLETE LIBRARY') {
      return null;
    }
    else if (!this.jsonData['parent']) {
      return 'COMPLETE LIBRARY'
    }
    else return this.jsonData['parent']
  };
  _propagateClick(clicked) {
    this.children.forEach(child => {
      child = PackagesState[child];
      [child.clicked, child.supersededByParent] = [clicked, clicked];
      child._propagateClick(clicked);
    })
  }
  markAsClicked = async function (writeToDisk=true) {
    /*
     * we want to correct for bad data. If both a parent and a child are marked as clicked, we need to make sure the
     * child is disabled. In the event that a child was marked before it's parent, the `disabled` parameter will trickle
     * down when the parent is marked. In case the parent was already marked, we'll look up the parent in
     * PackagesState.
     *
     * We've separated the concerns of marking which packages were clicked and actually downloading packages. Keeping
     * this distinction is important both for usability (we can run UI logic between the click and when the download
     * starts) and for maintainability.
     */
    this.clicked = true;
    const parent = PackagesState[this.parent];
    const supersededByParent = parent && parent.clicked;
    this.supersededByParent = Boolean(supersededByParent);

    this._propagateClick(true);
    if (writeToDisk)
      await AsyncStorage.setItem('packagesSelected', JSON.stringify(selectedPackages()));

  };
  unclick = async function () {
    /*
     * Set this package as desired = false.
     *
     * This method does not actually delete the books. Deleting takes some time. For better responsiveness it is
     * useful to be call the deleteBooks method explicitly.
     */
    if (this.supersededByParent) {
      throw "A disabled package cannot be unclicked"
    }

    this.clicked = false;
    this._propagateClick(false);
    await AsyncStorage.setItem('packagesSelected', JSON.stringify(selectedPackages()));


    // do we want to separate the concerns here? Less of an issue as there is not a network dependency
    setDesiredBooks();
    return calculateBooksToDelete(BooksState);
  };
  wasSelectedByUser = function () {
    return this.clicked && !this.supersededByParent
  }
}

class Book {
  constructor(title, desired, localLastUpdated=null) {
    this.title = title;
    this.desired = desired;
    if (!!localLastUpdated)
      this.localLastUpdated = new Date(localLastUpdated);
    else
      this.localLastUpdated = null;
  }
}


function downloadFilePromise(fileUrl, filepath, downloadFrom=0) {
  // useDownloadManager is for using the android download manager. Parameter is ignored on ios devices
  // Test with Appium
  const config = RNFB.config({
      IOSBackgroundTask: true,
      indicator: true,
      path: filepath,
      overwrite: true,
    });
  let filePromise;
  if (!!downloadFrom) {
    filePromise = config.fetch('GET', fileUrl, { Range: `bytes=${downloadFrom}-` })
  } else {
    filePromise = config.fetch('GET', fileUrl);
  }

  if (Platform.OS === "ios") {
    filePromise.expire(() => postDownload(filepath));
  }
  console.log(filePromise);
  return filePromise
}


function deriveDownloadState(pkgStateData) {
  // Test with Jest
  // pkgStateData is the contents of packages.json
  const packageResult = {};
  pkgStateData.forEach((pkgData, index) => {
    packageResult[pkgData['en']] = new Package(pkgData, index);
  });

  // children are not defined in package.json. Each package points to a parent and we can now use that to set children
  let parentPackage;
  for (let [packageTitle, packObj] of Object.entries(packageResult)) {
    if (packageTitle === 'COMPLETE LIBRARY') {}
    else {
      parentPackage = packObj.parent;
      packageResult[parentPackage].addChild(packageTitle);
    }
  }

  return packageResult
}

function loadJSONFile(JSONSourcePath) {
  // Test with Appium
  return new Promise((resolve, reject) => {
    RNFB.fs.readFile(JSONSourcePath).then(result => {
      let parsedResult;
      try {
        parsedResult = JSON.parse(result);
      } catch (e) {
        parsedResult = {}; // if file can't be parsed, fall back to empty object
      }
      resolve(parsedResult);
    }).catch(e => {
      reject(e);
    });
  })
}

async function loadCoreFile(filename) {
  // Test explicitly with Appium. Platform dependencies are not modeled well with Jest
  const exists = await RNFB.fs.exists(`${FILE_DIRECTORY}/${filename}`);

  if (exists || Platform.OS === "ios") {
    const pkgPath = exists ? `${FILE_DIRECTORY}/${filename}` : `${RNFB.fs.dirs.MainBundleDir}/sources/${filename}`;
    return await loadJSONFile(pkgPath);
  }
  else {
    try {
      const j = await RNFB.fs.readFile(RNFB.fs.asset(`sources/${filename}`));
      return JSON.parse(j)
    } catch (e) {
      console.log(`Error loading Android asset ${filename}: ${e}`);
      throw e
    }
  }
}

async function lastUpdated() {
  const lastUpdatedSource = `${FILE_DIRECTORY}/last_updated.json`;
  let exists = await RNFB.fs.exists(lastUpdatedSource);
  if (!exists)
    {
      return null;
    }
  return await loadJSONFile(lastUpdatedSource);
    /*
     * In the event the user never downloaded last_updated.json and the download failed we're going to throw out some
     * placeholder values. There might be a better way of dealing with this issue.
     */
  // return {  // todo: should we return with this object?
  //   schema_version: SCHEMA_VERSION,
  //   titles: []
  // };
}

function getFullBookList() { // todo: look at using Sefaria instance (Sefaria.booksDict). Use Sefaria.cacheIndexFromToc to initialize
  // Test with Jest
  return Object.keys(Sefaria.booksDict);
}

async function packageSetupProtocol() {
  // addDir adds a directory if it does not exist. We'll set up the app directory here
  await addDir(FILE_DIRECTORY);

  const [packageData, packagesSelected] = await Promise.all([
    loadCoreFile('packages.json').then(pkgStateData => deriveDownloadState(pkgStateData)),
    AsyncStorage.getItem('packagesSelected').then(x => !!x ? JSON.parse(x) : {})
  ]).catch(e => console.log(`failed in packageSetupProtocol: ${e}`));
  PackagesState = packageData;

  let falseSelections = [];
  for (let packName of Object.keys(packagesSelected)) {
    packageData[packName].markAsClicked(false)  // todo: markAsClicke is an async function
  }

  for (let packName of Object.keys(packagesSelected)) {
    if (!!packageData[packName].supersededByParent) {
      falseSelections.push(packName)
    }
  }
  if (falseSelections.length) {
    falseSelections.map(x => delete packagesSelected[x]);
    try {
      // this is here for cleaning up falseSelections on disk
      await AsyncStorage.setItem('packagesSelected', JSON.stringify(packagesSelected))
    } catch (e) {
      throw new Error(`AsyncStorage failed to save: ${error}`);
    }
  }
  await repopulateBooksState()
}

function setDesiredBooks() {
  // Test with Jest
  if (PackagesState['COMPLETE LIBRARY'].clicked) {
    Object.keys(BooksState).forEach(b => BooksState[b].desired = true)
  }
  else {
    // mark all books as not desired as a starting point
    Object.values(BooksState).map(x => x.desired=false);

    const selectedPackages = Object.values(PackagesState).filter(x => {
      /*
       * All books in packages marked desired should be flagged as desired. COMPLETE LIBRARY is a special case and
       * was dealt with above. Disabled packages are redundant (these are packages that are wholly contained within
       * a larger package that was already selected).
       */
      return x.name !== 'COMPLETE LIBRARY' && x.wasSelectedByUser()
    });
    selectedPackages.forEach(packageObj => {
      packageObj.jsonData['indexes'].forEach(book => {
        if (book in BooksState) {
          BooksState[book].desired = true;
        }
        else {  // edge case, new books should not be added here todo: add to crashlytics (look at ReaderApp 529)
          BooksState[book] = new Book(book, packageObj.clicked, null);
        }
      })
    })
  }

}

async function setLocalBookTimestamps(bookTitleList) {
  let fileData = await RNFB.fs.lstat(FILE_DIRECTORY);
  fileData = fileData.filter(x => x['filename'].endsWith('.zip'));
  const stamps = {};
  fileData.forEach(f => {
    const bookName = f['filename'].slice(0, -4);
    stamps[bookName] = new Date(parseInt(f['lastModified']));
  });

  bookTitleList.map(title => {
    const timestamp = (title in stamps) ? stamps[title] : null;
    if (title in BooksState)
      BooksState[title].localLastUpdated = timestamp;
    else
      BooksState[title] = new Book(title, false, timestamp);
  })
}

function getLocalBookList() {
  // Test with Appium?
  /*
   * This method is for getting the books that are stored on disk
   * Returns a Promise which resolves on a list of books
   */
  return new Promise((resolve, reject) => {
    RNFB.fs.ls(`${RNFB.fs.dirs.DocumentDir}/library`).then(fileList => {
      const books = [];
      const reg = /([^/]+).zip$/;
      fileList.forEach(fileName => { // todo: filter and map. Would be easier with async
        if (fileName.endsWith(".zip")) {
          books.push(reg.exec(fileName)[1]);
        }
      });
      resolve(books)
    }).catch(err=>reject(err))
  })
}

async function repopulateBooksState() {
  BooksState = {};
  const allBooks = getFullBookList();
  await setLocalBookTimestamps(allBooks);
  setDesiredBooks();
  return BooksState
}

async function deleteBooks(bookList) {
  // Test with Appium
  const deleteBook = async (bookTitle) => {
    const filepath = `${FILE_DIRECTORY}/${bookTitle}.zip`;
    const exists = await RNFB.fs.exists(filepath);
    if (exists) {
      try {
        await RNFB.fs.unlink(filepath);
      } catch (e) {
        console.log(`Error deleting file: ${e}`)
      }
    }
    return bookTitle
  };
  await throttlePromiseAll(bookList, deleteBook, 50);
  bookList.forEach(bookTitle => {
    if (bookTitle in BooksState) {
      BooksState[bookTitle].localLastUpdated = null;
      BooksState[bookTitle].desired = false;
    }
  });

  // deleting should clean out the tmp directory (this will clear out partially completed downloads)
  await cleanTmpDirectory();
}

async function unzipBundle(bundleSessionLocation) {
  // Test with Appium
  await addDir(FILE_DIRECTORY);
  await unzip(bundleSessionLocation, FILE_DIRECTORY);
}

function requestNewBundle(bookList) {
  // Test with Appium
  return new Promise((resolve, reject) => {
    fetch(`${DOWNLOAD_SERVER}/makeBundle`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({books: bookList})
    }).then(x => x.json()).then(x => resolve(x.bundle)).catch(err => reject(err))
  })
}

function isDownloadAllowed(networkState, downloadNetworkSetting) {
  console.log(`download setting is ${downloadNetworkSetting} and network type is ${networkState.type}. connected? ${networkState.isInternetReachable}`);
  if (!networkState.isInternetReachable) { return false }
  switch (networkState.type) {
    case 'none':
      return false;
    case 'wifi':
      return true;
    default:
      return downloadNetworkSetting !== 'wifiOnly';
  }
}

async function downloadRecover(networkMode='wifiOnly') {
  const networkState = await NetInfo.fetch();
  console.log(`networkState from fetch in downloadRecover: ${networkState.type}`);
  if (!isDownloadAllowed(networkState, networkMode)) {
    console.log('aborting download recovery: Download forbidden');
    return
  }
  console.log('recovering download');
  if (Tracker.downloadInProgress()) {
    console.log('another download is in progress, aborting recovery');
    return
  } else {
    console.log('proceeding with download recovery')
  }
  const stuff = JSON.parse(await AsyncStorage.getItem('lastDownloadLocation'));

  console.log(`values retrieved from AsyncStorage.lastDownloadLocation: ${stuff}`);
  console.log(stuff);
  const { filename, url, sessionStorageLocation } = stuff ? stuff : [null, null, null];
  if (!(filename) || !(url) || !(sessionStorageLocation)) {
    console.log('missing asyncStorage values');
    return
  }
  const exists = await RNFB.fs.exists(filename);
  if (!exists) {
    console.log('missing file');
    return
  }
  const sessionStorageExists = await RNFB.fs.exists(sessionStorageLocation);
  if (sessionStorageExists) {
    await RNFB.fs.appendFile(sessionStorageLocation, filename, 'uri');
  } else {
    await RNFB.fs.mv(filename, sessionStorageLocation);
  }

  const stat = await RNFB.fs.stat(sessionStorageLocation);
  console.log(stat);
  const size = stat.size;
  const newNetworkState = await NetInfo.fetch();
  await downloadBundle(url, networkMode,true, size);
}

async function downloadBundle(bundleName, networkSetting, recoveryMode=false, downloadFrom=0) {
  // Test with Appium
  console.log(`download ${bundleName} over ${networkSetting}. Recovery? ${recoveryMode}. Starting from ${downloadFrom}`);
  const getUniqueFilename = () => {  // It's not critical to have a truly unique filename
    return `${TMP_DIRECTORY}/${String(Math.floor(Math.random()*10000000))}.zip`
  };
  const getDownloadUrl = (bundle) => {
    if (recoveryMode) { return bundleName }
    return `${HOST_BUNDLE_URL}/${encodeURIComponent(bundle)}`
  };
  const [filename, url] = [getUniqueFilename(), getDownloadUrl(bundleName)];
  let sessionStorageLocation;
  if (recoveryMode) {
    sessionStorageLocation = JSON.parse(await AsyncStorage.getItem('lastDownloadLocation'))['sessionStorageLocation'];
    const exists = await RNFB.fs.exists(sessionStorageLocation);
    if (!exists){
      console.log('session storage file does not exist');
      return
    }
  } else {
    sessionStorageLocation = getUniqueFilename();
  }
  console.log(`sessionStorageLocation is ${sessionStorageLocation}`);

  try {
    await AsyncStorage.setItem('lastDownloadLocation', JSON.stringify({filename, url, sessionStorageLocation}))
  } catch (e) {
    console.log(`Failed to save lastDownloadLocation in AsyncStorage: ${e}`)
  }
  let stuff = await AsyncStorage.getItem('lastDownloadLocation');
  console.log(stuff);

  const downloadState = downloadFilePromise(url, filename, downloadFrom);
  // todo: schedule network event listeners
  console.log(downloadState.taskId);
  try {
    Tracker.addDownload(downloadState);
  } catch (e) {
    console.log(e)
  }
  let downloadResult;
  Tracker.addEventListener(networkSetting);
  try {
    downloadResult = await downloadState;
  }  catch (e) {
    console.log(`handling error from download failure: ${e}; message: ${e.message}`);
    Tracker.removeDownload();
    if (e.message === 'canceled') { return }  // don't start again if download "failed" due to user request
    else {
      /* Try again if download failed; recover will abort if the failure is due to network
       *
       * The NetInfo package is updated asynchronously. If we run immediately into a recovery download as soon as a
       * call to `fetch` fails, the Promise updating NetInfo won't get a chance to resolve. Because of this, it is
       * important to schedule the download recovery, rather than running into it directly. Hence the call to setTimeout.
       * Further investigation recommended.
       */
      setTimeout(async () => await downloadRecover(networkSetting), 250);
    }
    return
  }
  console.log(downloadResult);
  Tracker.removeDownload();
  Tracker.removeEventListener();
  const status = downloadResult.info().status;
  if (status >= 300 || status < 200) {
    throw "Bad download status"
  }
  await postDownload(downloadResult.path(), !recoveryMode, sessionStorageLocation);
}

async function calculateBooksToDownload(booksState) {
  // Test with Jest
  const remoteBookUpdates = await lastUpdated();
  if (remoteBookUpdates === null)
    {
      console.log('no last_updated.json');
      return [];
    }
  let booksToDownload = [];
  Object.keys(booksState).forEach(bookTitle => {
    const bookObj = booksState[bookTitle];
    if (bookObj.desired) {
      if (!bookObj.localLastUpdated) {
        booksToDownload.push(bookTitle);
      } else {
        const [localUpdate, remoteUpdate] = [booksState[bookTitle].localLastUpdated, new Date(remoteBookUpdates.titles[bookTitle])];
        if (localUpdate < remoteUpdate) {
          booksToDownload.push(bookTitle)
        }
      }
    }
  });
  return booksToDownload
}




function calculateBooksToDelete(booksState) {
  // Test with Jest
  let booksToDelete = [];
  for (const bookTitle in booksState) {  // todo: Object.entries with filter & map
    if (booksState.hasOwnProperty(bookTitle)) {
      const bookObj = booksState[bookTitle];
      if (!bookObj.desired && !!(bookObj.localLastUpdated)) {  // a book is on disk if localLastUpdated is set
        booksToDelete.push(bookTitle);
      }
    }
  }
  return booksToDelete;
}

async function _executeDownload(bundleName) {
  // Test with Appium
  // todo: make sure network is checked
  // todo: handle download interruption differently than download failure
  // break into two functions
  try {
    await downloadBundle(bundleName);  // don't worry about this one
  } catch (e) {
    console.log(`Handling error: ${e}`)
  } finally {
    await postDownload();
  }
}

async function cleanTmpDirectory() {
  console.log('cleaning tmp directory');
  const files = await RNFB.fs.ls(TMP_DIRECTORY);
  await Promise.all(files.map(f => RNFB.fs.unlink(`${TMP_DIRECTORY}/${f}`)));
}

async function postDownload(downloadPath, newDownload=true, sessionStorageLoc) {
  const exists = await RNFB.fs.exists(downloadPath);
  if (!exists) { return }

  if (newDownload) {
    try {
      console.log(`moving from ${downloadPath} to ${sessionStorageLoc}`);
      await RNFB.fs.mv(downloadPath, sessionStorageLoc);
    } catch (e) {
      console.log(e);
    }
  } else {
    await RNFB.fs.appendFile(sessionStorageLoc, downloadPath, 'uri');
  }
  console.log('unzipping bundle');
  try {
    await unzipBundle(sessionStorageLoc);
  } catch (e) {
    // Take to the settings page and check for updates?
  }
  await cleanTmpDirectory();

  await repopulateBooksState();
}

async function downloadPackage(packageName, networkSetting) {
  const netState = await NetInfo.fetch();
  if (isDownloadAllowed(netState, networkSetting)) {
    console.log('download allowed');
  } else {
    console.log('download forbidden');
    return
  }
  await downloadBundle(`${packageName}.zip`, networkSetting)
}

async function downloadUpdate(booksToDownload=null, networkSetting) {  // todo: get rid of null
  // Test with Appium
  if (!!booksToDownload){  // todo: review. Isn't this redundant. should it be !bookToDownload
    booksToDownload = await calculateBooksToDownload(BooksState);
  }
  const bundleName = await requestNewBundle(booksToDownload);
  await downloadBundle(bundleName, networkSetting);

  // we're going to use the update as an opportunity to do some cleanup
  const booksToDelete = calculateBooksToDelete(BooksState);
  await deleteBooks(booksToDelete);
}


function wereBooksDownloaded() {
  // Test with Jest
  return Object.values(PackagesState).some(x => !!x.clicked)
}

function booksNotDownloaded(bookList) {
  // Test with Jest
  /*
   * check a list of book titles against the BooksState to see which books in the list were not downloaded.
   * !IMPORTANT! Book data should only be derived from the files saved on disk. This method should be used only for
   * telegraphing information to the user, state should not be changed based on the results of this method.
   */
  return bookList.filter(x => !(x in BooksState) || !(BooksState[x].localLastUpdated))
}

async function markLibraryForDeletion() {
  // Test with Appium
  return await PackagesState['COMPLETE LIBRARY'].unclick()
}

async function addDir(path) {
  const exists = await RNFB.fs.exists(path);
  if (!exists) {
    try {
      await RNFB.fs.mkdir(path)
    } catch(e) {
      console.log(`Could not create directory at ${path}; ${e}`)
    }
  }
}

async function downloadCoreFile(filename) {
  // Test with Appium
  console.log(`downloading ${filename}`);
  await Promise.all([
    addDir(TMP_DIRECTORY),
    addDir(FILE_DIRECTORY),
  ]);

  const [fileUrl, tempPath] = [`${HOST_PATH}/${encodeURIComponent(filename)}`, `${TMP_DIRECTORY}/${filename}`];
  let downloadResp = null;
  try{
    downloadResp = await downloadFilePromise(fileUrl, tempPath);
  } catch (e) {
    console.log(e);
    return
  }
  const status = !!downloadResp ? downloadResp.info().status : 'total failure';
  if ((status >= 300 || status < 200) || (status === 'total failure')) {
    await RNFB.fs.unlink(tempPath);
    throw new Error(`bad download status; got : ${status}`);
  }
  else {
    console.log(`successfully downloaded ${filename} to ${tempPath} with status ${status}`);
  }
  try {
    await RNFB.fs.mv(tempPath, `${RNFB.fs.dirs.DocumentDir}/library/${filename}`);
  } catch(e) {
    console.log(`failed to move file at ${tempPath} to app storage: ${e}`);
    await RNFB.fs.unlink(tempPath);
  }
}

async function checkUpdatesFromServer() {
  // Test with Appium. Also worth timing this method to ensure it is responsive
  await schemaCheckAndPurge();
  let timestamp = new Date().toJSON();
  await AsyncStorage.setItem('lastUpdateCheck', timestamp);
  await AsyncStorage.setItem('lastUpdateSchema', SCHEMA_VERSION);
  // try {
  //   await downloadCoreFile().then(loadJSONFile(`${RNFB.fs.dirs.DocumentDir}/library/last_updated.json`));
  // } catch (e) {
  //   console.log(e)
  // }

  await Promise.all([
    downloadCoreFile('last_updated.json'),
    downloadCoreFile('toc.json').then(Sefaria._loadTOC),
    downloadCoreFile('search_toc.json').then(Sefaria._loadSearchTOC),
    downloadCoreFile('hebrew_categories.json').then(Sefaria._loadHebrewCategories),
    downloadCoreFile('people.json').then(Sefaria._loadPeople),
    downloadCoreFile('packages.json').then(packageSetupProtocol),
    downloadCoreFile('calendar.json').then(Sefaria._loadCalendar)
  ]);
  await repopulateBooksState();
  const allBooksToDownload = await calculateBooksToDownload(BooksState);
  return [allBooksToDownload, booksNotDownloaded(allBooksToDownload)]
}

function autoUpdateCheck() {
  /*
   * The mobile downloads are updated every 7 days. We want to prompt the user to update if they haven't checked the
   * server
   */
  return new Promise((resolve, reject) => {
    AsyncStorage.getItem('lastUpdateCheck').then(lastUpdateCheck => {
      const cutoff = new Date(lastUpdateCheck);
      cutoff.setDate(cutoff.getDate() + 7);
      const now = new Date();
      resolve(now > cutoff)
    }).catch(e => reject(e))
  })

}

function promptLibraryUpdate(totalDownloads, newBooks) {
  // Test with Jest
  /*
   * This is one of the few places we have UI components in this module. This is a point of control where the user
   * can interact directly with the update logic. This interaction is not unique to any one page on the app. Conversely,
   * any communication or UI logic that is unique to a particular app page or component should be written as part of
   * that component.
   */
  const updates = totalDownloads.length - newBooks.length;
  const updateString = `${newBooks.length} ${strings.newBooksAvailable}\n${updates} ${strings.updatesAvailableMessage}`;

  const onCancel = function () {
    Alert.alert(
      strings.updateLater,
      strings.howToUpdateLibraryMessage,
      [
        {text: strings.ok}
      ])
  };
  Alert.alert(
    strings.updateLibrary,
    updateString,
    [
      {text: strings.download, onPress: () => downloadUpdate(totalDownloads)},
      {text: strings.notNow, onPress: onCancel}
    ]
  )

}

async function schemaCheckAndPurge() {
  // Test with Jest
  // checks if there was a schema change. If so, delete the library
  const lastUpdateSchema = await AsyncStorage.getItem("lastUpdateSchema");
  if (lastUpdateSchema !== SCHEMA_VERSION) {
    // We want to delete the library but keep the package selections
    const bookList = getFullBookList();
    await deleteBooks(bookList);
    setDesiredBooks()
  }
}

async function throttlePromiseAll(argList, promiseCallback, maxWorkers=10) {
  let [promiseList, result] = [[], []];
  let resultSubset;
  for (let i=0; i < argList.length; i++) {
    if (promiseList.length >= maxWorkers) {
      resultSubset = await Promise.all(promiseList);
      result.push(...resultSubset);
      promiseList = [];
    }
    promiseList.push(promiseCallback(argList[i]));
  }
  resultSubset = await Promise.all(promiseList);
  result.push(...resultSubset);
  return result
}

function doubleDownload() {
  Alert.alert(
    strings.doubleDownload,
    '',
    [
      {text: strings.ok, onPress: () => {}}
    ]
  )
}

/*
Set a path for download. Save in async-storage. Make sure path is unique.
After download, move to BUNDLE_LOCATION
unzip from BUNDLE_LOCATION
clean up contents of temp directory

Download Recovery:
  check if the file at path of last download exists
  if so, move to BUNDLE_LOCATION
  download from (size_of_BUNDLE_LOCATION)
  append to BUNDLE_LOCATION

Let's stick to downloads over Wi-Fi only by default. I'm going to advocate for an option to allow downloads over a mobile
connection.

Don't allow download initiation if network is not available  -- why not?
On download initiation - set an event handler to cancel the download if network changes
When network comes back up, go for download recovery.
Advanced - Have Progress bar show "Paused" while download is paused


Event listeners are only present when a download is running.

Under network change:
  if download is allowed:
    try a new download (this will fail if another download is still running)
  if download is forbidden:
    remove the download

Under download failure:
  remove the download

Upon cancellation:  // to be run explicitly when StatefulPromise.cancel is called
  remove the download
  clean up tmp folder

seems like there is a situation where a failed download sticks around on the downloadTracker
something is off with rendering the progress bar for an existing download
 */

export {
  downloadBundle,
  packageSetupProtocol,
  wereBooksDownloaded,
  checkUpdatesFromServer,
  promptLibraryUpdate,
  downloadPackage,
  markLibraryForDeletion,
  loadJSONFile,
  getLocalBookList,
  getFullBookList,
  autoUpdateCheck,
  downloadUpdate,
  repopulateBooksState,
  PackagesState,
  BooksState,
  Package,
  Tracker,
  FILE_DIRECTORY,
  calculateBooksToDownload,
  calculateBooksToDelete,
  deleteBooks,
  downloadRecover,
  doubleDownload,
};
