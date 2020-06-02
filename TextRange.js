'use strict';
import PropTypes from 'prop-types';
import React, { useContext, useCallback } from 'react';
import {
  View,
  Text,
  Platform,
  Linking
} from 'react-native';
import ActionSheet from 'react-native-action-sheet';
import { GlobalStateContext, getTheme } from './StateManager';
import TextSegment from './TextSegment';
import styles from './Styles';
import strings from './LocalizedStrings';


const TextRange = React.memo(({
  showToast,
  rowData,
  segmentRef,
  showSegmentNumbers,
  textSegmentPressed,
  setRowRef,
  setRowRefInitY,
  fontScale,
  openUri,
  setDictionaryLookup,
}) => {
  const { themeStr, textLanguage, biLayout, fontSize } = useContext(GlobalStateContext);

  const theme = getTheme(themeStr);
  const _setRef = ref => {
    setRowRef(segmentRef, ref);
  };

  let enText = rowData.content.text || "";
  let heText = rowData.content.he || "";
  enText = Sefaria.util.getDisplayableHTML(enText, 'english');
  heText = Sefaria.util.getDisplayableHTML(heText, 'hebrew');
  let numLinks = rowData.content.links ? rowData.content.links.length : 0;

  let segment = [];
  const textLanguageWithContent = Sefaria.util.getTextLanguageWithContent(textLanguage, enText, heText);
  let refSection = rowData.sectionIndex + ":" + rowData.rowIndex;
  let numberMargin = (<Text
                        style={[styles.verseNumber, textLanguageWithContent == "hebrew" ? styles.hebrewVerseNumber : null, theme.verseNumber]}
                        key={segmentRef + "|segment-number"}>
                      {showSegmentNumbers ? (textLanguageWithContent == "hebrew" ?
                       Sefaria.hebrew.encodeHebrewNumeral(rowData.content.segmentNumber) :
                       rowData.content.segmentNumber) : ""}
                    </Text>);

  let bulletOpacity = (numLinks-20) / (70-20);
  if (numLinks == 0) { bulletOpacity = 0; }
  else if (bulletOpacity < 0.3) { bulletOpacity = 0.3; }
  else if (bulletOpacity > 0.8) { bulletOpacity = 0.8; }

  var bulletMargin = (<Text
                        style={[styles.verseBullet, theme.verseBullet, {opacity:bulletOpacity}]}
                        key={segmentRef + "|segment-dot"}>
                      {"●"}
                    </Text>);

  let textStyle = [styles.textSegment];
  if (rowData.highlight) {
      textStyle.push(theme.segmentHighlight);
  }
  if (biLayout === 'sidebyside') {
    textStyle.push({flexDirection: "row"})
  } else if (biLayout === 'sidebysiderev') {
    textStyle.push({flexDirection: "row-reverse"})
  }
  const showHe = textLanguageWithContent == "hebrew" || textLanguageWithContent == "bilingual";
  const showEn = textLanguageWithContent == "english" || textLanguageWithContent == "bilingual";
  return (
    <View
      style={styles.verseContainer}
      ref={_setRef}
    >
      <View
        style={[styles.numberSegmentHolderEn, {flexDirection: textLanguageWithContent === 'english' ? 'row' : 'row-reverse'}]}
        key={segmentRef+"|inner-box"}
      >
        { numberMargin }
        <View style={textStyle} key={segmentRef+"|text-box"}>
          {
            showHe ? (
              <TextSegment
              fontScale={fontScale}
              fontSize={fontSize}
              themeStr={themeStr}
              rowRef={segmentRef}
              segmentRef={segmentRef}
              segmentKey={refSection}
              key={segmentRef+"|hebrew"}
              data={heText}
              textType="hebrew"
              textSegmentPressed={ textSegmentPressed }
              showToast={showToast}
              setDictionaryLookup={setDictionaryLookup}
            />) : null
          }
          {
            showEn ? (<TextSegment
              fontScale={fontScale}
              fontSize={fontSize}
              themeStr={themeStr}
              rowRef={segmentRef}
              segmentKey={refSection}
              key={segmentRef+"|english"}
              data={enText}
              textType="english"
              bilingual={textLanguageWithContent === "bilingual"}
              textSegmentPressed={ textSegmentPressed }
              showToast={showToast}
              setDictionaryLookup={setDictionaryLookup}
            />) : null
          }
        </View>
        { bulletMargin }
      </View>
    </View>
  );
});
TextRange.whyDidYouRender = true;
TextRange.propTypes = {
  showToast:          PropTypes.func.isRequired,
  rowData:            PropTypes.object.isRequired,
  segmentRef:         PropTypes.string.isRequired,
  showSegmentNumbers: PropTypes.bool.isRequired,
  textSegmentPressed: PropTypes.func.isRequired,
  setRowRef:          PropTypes.func.isRequired,
  setRowRefInitY:     PropTypes.func.isRequired,
  fontScale:          PropTypes.object,
};

export default TextRange;
