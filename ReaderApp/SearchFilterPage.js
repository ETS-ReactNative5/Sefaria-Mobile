'use strict';

import PropTypes from 'prop-types';
import React, { Component } from 'react';
import {
	View,
	Text,
	TouchableOpacity,
	ScrollView
} from 'react-native';

var {
	DirectedButton,
	ButtonToggleSet
} = require('./Misc.js');

const styles           = require('./Styles');
const strings          = require('./LocalizedStrings');

class SearchFilterPage extends React.Component {
  static propTypes = {
    theme:         PropTypes.object.isRequired,
    themeStr:      PropTypes.string.isRequired,
    query:         PropTypes.string,
    sort:          PropTypes.string,
    isExact:       PropTypes.bool,
    openSubMenu:   PropTypes.func,
    onQueryChange: PropTypes.func,
    setSearchOptions: PropTypes.func
  };

  constructor(props) {
    super(props);
    this.sortOptions = [
      {name: "chronological", text: strings.chronological, onPress: () => { this.props.setSearchOptions("chronological", this.props.isExact); }},
      {name: "relevance", text: strings.relevance, onPress: () => { this.props.setSearchOptions("relevance", this.props.isExact); }}
    ];
    this.exactOptions = [
      {name: false, text: strings.allResults, onPress: () => { this.props.setSearchOptions(this.props.sort, false); }},
      {name: true, text: strings.exactMatches, onPress: () => { this.props.setSearchOptions(this.props.sort, true); }}
    ];
  }


  backFromFilter = () => {
		this.props.openSubMenu(null);
		this.props.onQueryChange(this.props.query, true, false);
	};

  render() {
    var isheb = this.props.interfaceLang === "hebrew";
    var langStyle = !isheb ? styles.enInt : styles.heInt;
    var backImageStyle = isheb ? styles.directedButtonWithTextHe : styles.directedButtonWithTextEn;

    return (<View style={{flex:1}}>
      <View style={[styles.header, this.props.theme.header, {justifyContent: "space-between"}]}>
        <DirectedButton
          onPress={this.backFromFilter}
          theme={this.props.theme}
          themeStr={this.props.themeStr}
          text="Back"
          direction="back"
          language="english"
          textStyle={[this.props.theme.searchResultSummaryText, langStyle]}
          imageStyle={[styles.menuButton, backImageStyle]}/>
        <TouchableOpacity onPress={this.backFromFilter} style={{marginLeft: 12, marginRight: 12}}>
          <Text style={[this.props.theme.searchResultSummaryText, langStyle]}>{"Apply"}</Text>
        </TouchableOpacity>
      </View>
      <ScrollView style={styles.menuContent}>
        <View style={styles.settingsSection}>
          <View>
            <Text style={[styles.settingsSectionHeader, this.props.theme.tertiaryText]}>{strings.sortBy}</Text>
          </View>
          <ButtonToggleSet
            theme={this.props.theme}
            options={this.sortOptions}
            contentLang={"english"}
            active={this.props.sort} />
        </View>
        <View style={styles.settingsSection}>
          <View>
            <Text style={[styles.settingsSectionHeader, this.props.theme.tertiaryText]}>{strings.filterTexts}</Text>
          </View>
          <ButtonToggleSet
            theme={this.props.theme}
            options={this.exactOptions}
            contentLang={"english"}
            active={this.props.isExact} />
        </View>
        <View style={styles.settingsSection}>
          <View>
            <Text style={[styles.settingsSectionHeader, this.props.theme.tertiaryText]}>{strings.category}</Text>
          </View>
        </View>
      </ScrollView>
    </View>);
  }
}

module.exports = SearchFilterPage;
